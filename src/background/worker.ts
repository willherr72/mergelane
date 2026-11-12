import { applySettingsAction } from '../core/actions';
import { emptyStatus, hasCredentials } from '../core/model';
import { ApiError, GitHubClient, emptyCache } from '../github/client';
import { initializeStorage, openPullRequests, publicState, readCleanup, readDiscovery, readHealth, readRunState, readSettings } from '../storage';
import { addClosure, canonicalPr, setProtection } from '../core/cleanup';
import { healthFromRun, putHealth } from '../core/health';
import { parsePrUrl } from '../core/url';
import { verificationRefs, verifyConnection, type ConnectionCheck } from '../github/connection';
import { reconcile } from './reconcile';
import { OwnerClient } from '../github/owners';
import { beginImport, cancelImports, importSession, requireImportSession } from './token-import';
import { selectGeneratedToken } from '../core/token-import';
import { discoverPullRequests, mergeHandledDiscovery } from './discovery';

let epoch = 0;
let rerun = false;
let running: Promise<void> | null = null;
let forceDiscovery = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<unknown> = Promise.resolve();
const pendingKept = new Map<string, number>();
function queued<T>(action: () => Promise<T>): Promise<T> {
  const task = saveQueue.then(action); saveQueue = task.catch(() => {}); return task;
}
const ready = initializeStorage().then(async () => {
  if (!await chrome.alarms.get('refresh')) await chrome.alarms.create('refresh', { periodInMinutes: 1 });
});

async function reportFailure(error: unknown): Promise<void> {
  const message = error instanceof ApiError ? error.message : 'MergeLane could not finish its check. Open Settings to check the connection and configuration.';
  await chrome.storage.local.set({ status: { ...emptyStatus(), attemptedAt: Date.now(), errors: [{ pr: '', message }] } });
}

async function runOnce(force = false): Promise<void> {
  const ticket = epoch;
  const settings = await readSettings();
  const state = await readRunState();
  if (ticket !== epoch) { rerun = true; return; }
  if (!settings.enabled || !hasCredentials(settings)) {
    await chrome.storage.local.set({ status: { ...state.status, running: false } });
    return;
  }
  await chrome.storage.local.set({ status: { ...state.status, running: true } });
  const client = new OwnerClient(settings, state.caches);
  const cleanup = await readCleanup();
  const result = await reconcile({ chrome, settings, ownership: state.ownership, api: client, now: Date.now, isCurrent: () => ticket === epoch, keptKeys: new Set([...cleanup.kept.map(pr => pr.key), ...pendingKept.keys()]), onClosed: pr => queued(async () => { await chrome.storage.local.set({ cleanup: addClosure(await readCleanup(), pr) }); }) });
  // Ownership describes actual browser mutations, even if settings changed
  // after some of those mutations. Preserve it for the next reconciliation.
  await chrome.storage.session.set({ ownership: state.ownership });
  if (ticket !== epoch) { rerun = true; return; }
  const discovered = await discoverPullRequests({ chrome, settings, api: client, state: await readDiscovery(), now: Date.now, isCurrent: () => ticket === epoch, force, save: (discovery, handled) => queued(async () => {
    if (ticket === epoch) { await chrome.storage.local.set({ discovery }); return; }
    if (handled && (await readSettings()).connections.some(c => c.owner.toLowerCase() === handled.owner)) {
      const current = await readDiscovery();
      mergeHandledDiscovery(current, handled);
      await chrome.storage.local.set({ discovery: current });
    }
  }) });
  result.errors.push(...discovered.errors);
  if (discovered.errors.length) result.checkedAt = null;
  if (discovered.retryAt) result.retryAt = Math.max(result.retryAt ?? 0, discovered.retryAt);
  await queued(async () => {
    if (ticket !== epoch) { rerun = true; return; }
    await chrome.storage.local.set({ connectionCaches: client.exportCaches(), connectionHealth: healthFromRun(await readHealth(), settings, result, Date.now()), status: { ...result, checkedAt: result.checkedAt ?? state.status.checkedAt, running: false } });
  });
}

function requestRun(force = false): Promise<void> {
  forceDiscovery ||= force;
  rerun = true;
  if (running) return running;
  running = (async () => {
    await ready;
    while (rerun) {
      rerun = false;
      const force = forceDiscovery; forceDiscovery = false;
      try { await runOnce(force); } catch (error) { await reportFailure(error); }
    }
  })().finally(() => { running = null; });
  return running;
}
function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => { void requestRun().catch(reportFailure); }, 350);
}

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'refresh') void requestRun().catch(reportFailure); });
chrome.runtime.onStartup.addListener(schedule);
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
  schedule();
});
chrome.tabs.onCreated.addListener(schedule);
chrome.tabs.onRemoved.addListener(id => { schedule(); void queued(() => cancelImports(s => s.tabId === id)).catch(() => {}); });
chrome.tabs.onAttached.addListener(schedule);
chrome.tabs.onDetached.addListener(schedule);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url !== undefined || change.pinned !== undefined || change.status === 'complete') schedule();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { epoch++; schedule(); }
});

async function handleMessage(message: unknown): Promise<unknown> {
  await ready;
  if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid request.');
  const request = message as Record<string, unknown>;
  if (request.type === 'getState') return publicState();
  if (request.type === 'refresh') { await requestRun(true); return publicState(); }
  if (['keepOpen', 'resumeCleanup', 'reopenClosed', 'clearRecent'].includes(String(request.type))) {
    // Protection takes effect on receipt, even while a slow credential check
    // holds the command queue. Every new reconciliation sees pending keys.
    const pendingKey = ['keepOpen', 'reopenClosed'].includes(String(request.type)) && typeof request.key === 'string' ? request.key : null;
    if (pendingKey) { pendingKept.set(pendingKey, (pendingKept.get(pendingKey) ?? 0) + 1); epoch++; }
    return queued(async () => {
    const cleanup = await readCleanup();
    if (request.type === 'clearRecent') { await chrome.storage.local.set({ cleanup: { ...cleanup, recent: [] } }); return publicState(); }
    if (typeof request.key !== 'string') throw new Error('Choose a tracked PR.');
    const key = request.key;
    let pr = request.type === 'reopenClosed' ? cleanup.recent.find(pr => pr.key === key) : cleanup.kept.find(pr => pr.key === key);
    if (request.type === 'keepOpen') {
      const ref = (await openPullRequests()).find(ref => ref.key === key);
      if (ref) pr = canonicalPr(`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`, (await readRunState()).status.prs.find(pr => pr.key === key)?.title ?? '');
    }
    if (!pr || canonicalPr(pr.url, pr.title).key !== key) throw new Error('This PR is no longer in the requested list. Refresh and try again.');
    epoch++;
    await chrome.storage.local.set({ cleanup: setProtection(cleanup, pr, request.type !== 'resumeCleanup') });
    if (request.type === 'reopenClosed') {
      const existing = (await chrome.tabs.query({ windowType: 'normal' })).find(tab => !tab.incognito && parsePrUrl(tab.pendingUrl || tab.url)?.key === key);
      if (existing?.id !== undefined) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
      else await chrome.tabs.create({ url: canonicalPr(pr.url, pr.title).url });
    }
    schedule(); return publicState();
    }).finally(() => {
      if (pendingKey) { const count = pendingKept.get(pendingKey)! - 1; if (count) pendingKept.set(pendingKey, count); else pendingKept.delete(pendingKey); epoch++; schedule(); }
    });
  }
  if (request.type === 'beginImport') return queued(async () => { await beginImport(typeof request.owner === 'string' ? request.owner.trim() : '', request.mode === 'add' || request.mode === 'replace' ? request.mode : undefined); return publicState(); });
  if (['saveSettings', 'setEnabled', 'setToken', 'disconnect', 'checkConnection', 'removeConnection'].includes(String(request.type))) return queued(() => changeSettings(request));
  throw new Error('Unknown request.');
}

async function changeSettings(request: Record<string, unknown>, beforeSave?: () => Promise<void>) {
  const existing = await readSettings();
  const settings = request.type === 'checkConnection' ? existing : applySettingsAction(existing, request);
  const owner = typeof request.owner === 'string' ? request.owner.trim() : '';
  if (owner && !/^[a-z\d][a-z\d-]{0,38}$/i.test(owner)) throw new Error('Enter a GitHub organization or account name.');
  const token = settings.connections.find(c => c.owner.toLowerCase() === owner.toLowerCase())?.token ?? settings.token;
  let connectionCheck: ConnectionCheck | undefined;
  if (request.type === 'setToken' || request.type === 'checkConnection') {
    try { connectionCheck = await verifyConnection(new GitHubClient(token, emptyCache()), verificationRefs(await openPullRequests(), settings, owner), owner); }
    catch (error) {
      if (request.type === 'checkConnection') await chrome.storage.local.set({ connectionHealth: putHealth(await readHealth(), { owner: settings.connections.some(c => c.owner.toLowerCase() === owner.toLowerCase()) ? owner : '', status: 'error', checkedAt: Date.now(), message: error instanceof ApiError ? error.message : 'Could not check this connection.' }) });
      throw error;
    }
    if (request.type === 'checkConnection') {
      await chrome.storage.local.set({ connectionHealth: putHealth(await readHealth(), { owner: settings.connections.some(c => c.owner.toLowerCase() === owner.toLowerCase()) ? owner : '', status: connectionCheck.checked ? 'verified' : 'account-only', checkedAt: Date.now(), message: connectionCheck.checked ? `Access verified for ${connectionCheck.checked} PRs.` : 'Account verified; repository access has not been tested.' }) });
      return { ...await publicState(), connectionCheck };
    }
  }
  await beforeSave?.();
  epoch++;
  const values: Record<string, unknown> = { settings };
  if (connectionCheck) values.connectionHealth = putHealth(await readHealth(), { owner, status: connectionCheck.checked ? 'verified' : 'account-only', checkedAt: Date.now(), message: connectionCheck.checked ? `Access verified for ${connectionCheck.checked} PRs.` : 'Account verified; repository access has not been tested.' });
  if (['setToken', 'removeConnection', 'disconnect'].includes(String(request.type))) {
    const { caches } = await readRunState();
    values.cache = emptyCache(); values.status = emptyStatus();
    values.connectionCaches = request.type === 'disconnect' ? [] : caches.filter(c => c.owner !== owner.toLowerCase());
    const discovery = await readDiscovery();
    if (request.type === 'removeConnection') delete discovery[owner.toLowerCase()];
    // Token replacement keeps handled PRs, but permits an immediate rescan.
    if (request.type === 'setToken' && Object.hasOwn(discovery, owner.toLowerCase())) {
      discovery[owner.toLowerCase()].attemptedAt = 0;
      delete discovery[owner.toLowerCase()].error;
    }
    values.discovery = request.type === 'disconnect' ? {} : discovery;
  }
  if (request.type === 'disconnect' || request.type === 'removeConnection') await cancelImports(s => request.type === 'disconnect' || s.owner.toLowerCase() === owner.toLowerCase());
  if (request.type === 'disconnect' || request.type === 'removeConnection') values.connectionHealth = (await readHealth()).filter(h => request.type !== 'disconnect' && h.owner !== owner.toLowerCase());
  await chrome.storage.local.set(values);
  schedule();
  return { ...await publicState(), connectionCheck };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let task: Promise<unknown>;
  if (sender.url?.startsWith(chrome.runtime.getURL(''))) task = handleMessage(message);
  else if (message?.type === 'importContext') task = queued(async () => { await ready; const session = await importSession(sender); return session ? { owner: session.owner } : null; });
  else if (message?.type === 'importToken') task = queued(async () => {
    await ready;
    const session = await requireImportSession(sender);
    if (typeof message.token !== 'string') throw new Error('No generated token was provided.');
    const token = selectGeneratedToken([message.token]);
    const result = await changeSettings({ type: 'setToken', token, owner: session.owner, mode: session.mode }, async () => { await requireImportSession(sender); });
    await cancelImports(s => s.tabId === session.tabId);
    void chrome.runtime.openOptionsPage().catch(() => {});
    return { connectionCheck: result.connectionCheck };
  });
  else return;
  void task.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error instanceof Error ? error.message : 'The operation could not be completed.' }));
  return true;
});
void ready.then(schedule).catch(reportFailure);
