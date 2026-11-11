import { applySettingsAction } from '../core/actions';
import { emptyStatus, hasCredentials } from '../core/model';
import { ApiError, GitHubClient, emptyCache } from '../github/client';
import { initializeStorage, openPullRequests, publicState, readRunState, readSettings } from '../storage';
import { verifyConnection, type ConnectionCheck } from '../github/connection';
import { reconcile } from './reconcile';
import { OwnerClient } from '../github/owners';
import { beginImport, cancelImports, importSession, requireImportSession } from './token-import';
import { selectGeneratedToken } from '../core/token-import';

let epoch = 0;
let rerun = false;
let running: Promise<void> | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<unknown> = Promise.resolve();
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

async function runOnce(): Promise<void> {
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
  const result = await reconcile({ chrome, settings, ownership: state.ownership, api: client, now: Date.now, isCurrent: () => ticket === epoch });
  // Ownership describes actual browser mutations, even if settings changed
  // after some of those mutations. Preserve it for the next reconciliation.
  await chrome.storage.session.set({ ownership: state.ownership });
  if (ticket !== epoch) { rerun = true; return; }
  await chrome.storage.local.set({ connectionCaches: client.exportCaches(), status: { ...result, checkedAt: result.checkedAt ?? state.status.checkedAt, running: false } });
}

function requestRun(): Promise<void> {
  rerun = true;
  if (running) return running;
  running = (async () => {
    await ready;
    while (rerun) {
      rerun = false;
      try { await runOnce(); } catch (error) { await reportFailure(error); }
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
  if (request.type === 'refresh') { await requestRun(); return publicState(); }
  if (request.type === 'beginImport') return queued(async () => { await beginImport(typeof request.owner === 'string' ? request.owner.trim() : ''); return publicState(); });
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
    connectionCheck = await verifyConnection(new GitHubClient(token, emptyCache()), await openPullRequests(), owner);
    if (request.type === 'checkConnection') return { ...await publicState(), connectionCheck };
  }
  await beforeSave?.();
  epoch++;
  const values: Record<string, unknown> = { settings };
  if (['setToken', 'removeConnection', 'disconnect'].includes(String(request.type))) {
    const { caches } = await readRunState();
    values.cache = emptyCache(); values.status = emptyStatus();
    values.connectionCaches = request.type === 'disconnect' ? [] : caches.filter(c => c.owner !== owner.toLowerCase());
  }
  if (request.type === 'disconnect' || request.type === 'removeConnection') await cancelImports(s => request.type === 'disconnect' || s.owner.toLowerCase() === owner.toLowerCase());
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
    const result = await changeSettings({ type: 'setToken', token, owner: session.owner }, async () => { await requireImportSession(sender); });
    await cancelImports(s => s.tabId === session.tabId);
    void chrome.runtime.openOptionsPage().catch(() => {});
    return { connectionCheck: result.connectionCheck };
  });
  else return;
  void task.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error instanceof Error ? error.message : 'The operation could not be completed.' }));
  return true;
});
void ready.then(schedule).catch(reportFailure);
