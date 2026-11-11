import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = path.resolve(artifacts, `smoke-profile-${Date.now()}`);
const extension = path.join(root, 'dist');
const checks = [], errors = [];
const launch = () => chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let context = await launch();
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture PR</title><p>Isolated MergeLane smoke test. No live GitHub data.</p>' }));
let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const fixtures = { labels: {}, merged: {}, closed: {} };

async function installFixtures(data) {
  await worker.evaluate(data => {
    globalThis.__fixture = data;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.origin !== 'https://api.github.com') throw new Error('Unexpected test request');
      if (url.pathname === '/user') {
        if (globalThis.__blockAccount) { globalThis.__accountWaiting = true; await new Promise(resolve => { globalThis.__releaseAccount = resolve; }); }
        return json({ login: 'fixture-user' });
      }
      if (new Headers(init?.headers).get('Authorization') === 'Bearer wrong-owner-fixture') return new Response('', { status: 404 });
      const match = url.pathname.match(/\/(pulls|issues)\/(\d+)(.*)$/);
      if (!match) throw new Error('Unexpected fixture path');
      const n = Number(match[2]), tail = match[3];
      const person = login => ({ login, type: 'User' });
      if (!tail) {
        const merged = globalThis.__fixture.merged[n] ?? n === 5;
        const closed = globalThis.__fixture.closed[n] ?? (n === 6 ? 7200000 : n === 7 ? 1800000 : null);
        return json({ state: merged || closed !== null ? 'closed' : 'open', merged, closed_at: closed !== null ? new Date(Date.now() - closed).toISOString() : merged ? new Date().toISOString() : null, draft: false, user: person('author'), labels: (globalThis.__fixture.labels[n] ?? (n === 4 ? ['mergify-queue'] : [])).map(name => ({ name })), title: `Fixture PR ${n}` });
      }
      if (match[1] === 'issues' && tail === '/comments') return json(n === 2 ? [{ user: person('alice') }] : [{ user: person('author') }, { user: { login: 'supabase[bot]', type: 'Bot' } }]);
      if (tail === '/reviews') return json([3, 4, 8].includes(n) ? [{ id: n, state: n === 8 ? 'CHANGES_REQUESTED' : 'APPROVED', submitted_at: '2026-11-10T12:00:00Z', user: person('reviewer') }] : []);
      return json([]);
    };
  }, data);
}

try {
  await installFixtures(fixtures);
  let options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.getByLabel('Name', { exact: true }).waitFor();
  const send = (type, data = {}) => options.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ type, ...data });
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }, { type, data });
  const waitForTabs = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const ready = await worker.evaluate(async () => (await chrome.tabs.query({})).every(t => t.status !== 'loading' && !t.pendingUrl));
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Fixture tabs did not finish navigation.');
  };
  const initial = await send('getState');
  assert.equal(initial.settings.enabled, false); assert.equal(initial.hasToken, false);
  assert.equal(initial.settings.token, ''); checks.push('Fresh install is paused and public state omits the credential.');

  await options.getByRole('button', { name: 'Add connection', exact: true }).click();
  assert.equal(await options.getByLabel('Resource owner', { exact: true }).inputValue(), '');
  await options.getByLabel('Resource owner', { exact: true }).fill('org');
  await options.getByLabel('Personal access token', { exact: true }).fill('fixture-token-not-a-real-secret');
  await options.getByRole('button', { name: 'Save connection', exact: true }).click();
  await options.locator('#connectionResult').filter({ hasText: 'Repository access has not been tested' }).waitFor();
  assert.equal(await options.getByLabel('Personal access token', { exact: true }).count(), 0);
  await options.locator('[data-owner="org"]').filter({ hasText: 'Account verified · repository access untested' }).waitFor();
  const probe = await context.newPage(); await probe.goto('https://github.com/org/repo/pull/1');
  await waitForTabs(); await options.reload();
  await options.getByRole('button', { name: 'Add connection', exact: true }).click();
  assert.equal(await options.getByLabel('Resource owner', { exact: true }).inputValue(), '');
  await options.getByLabel('Resource owner', { exact: true }).fill('ORG');
  assert.equal(await options.getByRole('button', { name: 'Save connection', exact: true }).isDisabled(), true);
  await options.getByRole('button', { name: 'Cancel', exact: true }).click();
  await options.getByRole('button', { name: 'Replace org token', exact: true }).click();
  assert.equal(await options.getByLabel('Resource owner', { exact: true }).inputValue(), 'org');
  assert.equal(await options.getByLabel('Resource owner', { exact: true }).getAttribute('readonly'), '');
  const tokenLink = new URL(await options.getByRole('link', { name: 'Create token for org', exact: true }).getAttribute('href'));
  assert.equal(tokenLink.searchParams.get('target_name'), 'org');
  assert.equal(tokenLink.searchParams.get('pull_requests'), 'read');
  assert.equal(tokenLink.searchParams.get('issues'), 'read');
  await options.getByLabel('Personal access token', { exact: true }).fill('wrong-owner-fixture');
  await options.getByRole('button', { name: 'Replace token', exact: true }).click();
  await options.locator('#connectionResult').filter({ hasText: 'Resource owner to org' }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.connections.find(c => c.owner === 'org').token === 'fixture-token-not-a-real-secret'), true);
  assert.equal((await send('getState')).settings.enabled, false);
  assert.equal(await options.getByLabel('Personal access token', { exact: true }).inputValue(), 'wrong-owner-fixture');
  await options.getByLabel('Personal access token', { exact: true }).fill('fixture-token-not-a-real-secret');
  await options.getByRole('button', { name: 'Replace token', exact: true }).click();
  await options.locator('#connectionResult').filter({ hasText: 'Access verified for 1 PR under org' }).waitFor();
  await options.getByRole('button', { name: 'Check org connection', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Access verified for 1 PR under org' }).waitFor();
  await probe.close();
  checks.push('Owner-prefilled setup rejects a valid account token without repository access, preserves the previous token, and verifies PR access on retry.');
  checks.push('Add connection starts blank, rejects duplicate owners, and Replace token locks the saved owner with accurate connection health.');
  await options.getByRole('button', { name: 'Enable MergeLane', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  checks.push('Token setup validates the account, clears the input, and requires explicit enable.');

  await worker.evaluate(async () => {
    for (let n = 1; n <= 7; n++) await chrome.tabs.create({ url: `https://github.com/org/repo/pull/${n}`, active: false });
  });
  await waitForTabs();
  // Explicit refresh waits for all queued reconciliation work, including
  // runs scheduled by real tab-close events.
  await send('refresh');
  let actual = await worker.evaluate(async () => ({ tabs: await chrome.tabs.query({}), groups: await chrome.tabGroups.query({}) }));
  const prTabs = actual.tabs.filter(t => t.url?.includes('/org/repo/pull/'));
  assert.deepEqual(prTabs.map(t => Number(t.url.match(/pull\/(\d+)/)[1])).sort((a, b) => a - b), [1, 2, 3, 4, 7]);
  const nameFor = n => actual.groups.find(g => g.id === actual.tabs.find(t => t.url === `https://github.com/org/repo/pull/${n}`)?.groupId)?.title;
  assert.equal(nameFor(1), 'In Progress'); assert.equal(nameFor(2), 'In Review'); assert.equal(nameFor(3), 'Approved'); assert.equal(nameFor(4), 'Merging');
  checks.push('Native groups reflect bot-only, human-comment, approval, and queue-label states.');
  checks.push('Merged and two-hour-closed tabs close; a thirty-minute-closed tab stays open.');

  await worker.evaluate(async () => {
    await chrome.tabs.create({ url: 'https://github.com/org/repo/pull/3/files', pinned: true, active: false });
    await chrome.windows.create({ url: 'https://github.com/org/repo/pull/2', focused: false });
  });
  await waitForTabs();
  await send('refresh');
  actual = await worker.evaluate(async () => ({ tabs: await chrome.tabs.query({}), groups: await chrome.tabGroups.query({}) }));
  assert.equal(actual.tabs.find(t => t.url?.endsWith('/pull/3/files'))?.groupId, -1);
  assert.equal(actual.groups.filter(g => g.title === 'In Review').length, 2);
  checks.push('Pinned PRs remain ungrouped; separate windows get separate groups.');

  await options.getByRole('button', { name: 'Edit Merging', exact: true }).click();
  await options.getByLabel('Name', { exact: true }).fill('Queued');
  await options.getByLabel('Condition 1 label name', { exact: true }).fill('queue-next');
  await options.getByRole('button', { name: 'Save changes', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  await worker.evaluate(() => { globalThis.__fixture.labels[4] = ['queue-next']; });
  await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabGroups.query({}))).some(g => g.title === 'Queued'), true);
  checks.push('Editing a category name and queue label persists and changes native grouping.');

  await options.getByRole('button', { name: 'Add a lane', exact: true }).click();
  await options.getByLabel('Name', { exact: true }).fill('Changes requested');
  await options.getByLabel('Condition 1 type', { exact: true }).selectOption('changes');
  await options.getByRole('button', { name: 'Save changes', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  await worker.evaluate(() => chrome.tabs.create({ url: 'https://github.com/org/repo/pull/8', active: false }));
  await waitForTabs();
  await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabGroups.query({}))).some(g => g.title === 'Changes requested'), true);
  await options.reload();
  await options.getByRole('button', { name: 'Edit Changes requested', exact: true }).waitFor();
  checks.push('A user-defined changes-requested category survives reload and groups matching PRs.');

  let popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('button', { name: 'Pause', exact: true }).click();
  await popup.getByRole('button', { name: 'Enable MergeLane', exact: true }).waitFor();
  await worker.evaluate(() => chrome.tabs.create({ url: 'https://github.com/org/repo/pull/5', active: false }));
  await waitForTabs();
  await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url?.endsWith('/pull/5')), true);
  await popup.getByRole('button', { name: 'Enable MergeLane', exact: true }).click();
  await popup.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url?.endsWith('/pull/5')), false);
  checks.push('Popup pause prevents cleanup; resuming reapplies it.');

  // Stop and restart the actual MV3 worker while paused, then restore fixture
  // transport before enabling it again. Production has no test-only hooks.
  let current = await send('getState');
  await send('setEnabled', { enabled: false }); await send('refresh');
  const groupsBefore = (await worker.evaluate(() => chrome.tabGroups.query({}))).map(g => g.id).sort();
  const fixtureState = await worker.evaluate(() => globalThis.__fixture);
  await worker.evaluate(() => chrome.alarms.clear('refresh'));
  const cdp = await context.newCDPSession(options);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  await send('getState');
  worker = context.serviceWorkers().find(w => w.url().includes(id)) ?? worker;
  await installFixtures(fixtureState);
  assert.ok(await worker.evaluate(() => chrome.alarms.get('refresh')));
  current = await send('getState');
  await send('setEnabled', { enabled: true }); await send('refresh');
  assert.deepEqual((await worker.evaluate(() => chrome.tabGroups.query({}))).map(g => g.id).sort(), groupsBefore);
  checks.push('Worker restart reconstructs the alarm and reuses session-owned groups.');

  // An old options draft must not resume management after a popup pause.
  await options.getByRole('button', { name: 'Edit Queued', exact: true }).click();
  await options.getByLabel('Name', { exact: true }).fill('Queue edited while active');
  await popup.getByRole('button', { name: 'Pause', exact: true }).click();
  await popup.getByRole('button', { name: 'Enable MergeLane', exact: true }).waitFor();
  await options.getByRole('button', { name: 'Save changes', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  assert.equal((await send('getState')).settings.enabled, false);
  checks.push('Saving an old category draft cannot undo a pause from the popup.');

  await popup.getByRole('button', { name: 'Enable MergeLane', exact: true }).click();
  await popup.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await options.getByRole('button', { name: 'Add condition', exact: true }).click();
  await options.getByRole('button', { name: 'Pause', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'MergeLane is paused' }).waitFor();
  assert.equal((await send('getState')).settings.enabled, false);
  await options.getByRole('button', { name: 'Disconnect all', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Disconnected' }).waitFor();
  assert.equal((await send('getState')).hasToken, false);
  checks.push('Pause and Disconnect work even with an unfinished, invalid rule draft.');

  // Discard the unfinished edit and restore a connected, active screenshot.
  options.once('dialog', dialog => dialog.accept());
  await options.reload();
  await options.getByRole('button', { name: 'Add connection', exact: true }).click();
  await options.getByLabel('Resource owner', { exact: true }).fill('org');
  await options.getByLabel('Personal access token', { exact: true }).fill('fixture-token-not-a-real-secret');
  await options.getByRole('button', { name: 'Save connection', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Access verified' }).waitFor();
  await options.getByRole('button', { name: 'Enable MergeLane', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  await options.getByRole('button', { name: 'Edit Queue edited while active', exact: true }).click();
  await options.getByLabel('Name', { exact: true }).fill('Queued');
  await options.getByRole('button', { name: 'Save changes', exact: true }).click();
  await options.locator('#toast').filter({ hasText: 'Settings saved' }).waitFor();
  await send('refresh');

  await popup.reload();
  await popup.locator('[data-pr="org/repo/2"]').filter({ hasText: 'Another person commented or reviewed' }).waitFor();
  await popup.locator('[data-pr="org/repo/4"]').filter({ hasText: 'Has label “queue-next”' }).waitFor();
  checks.push('Popup explanations show the matching human-feedback and configured queue-label rules beside each PR.');
  const staleBeforeProtection = (await send('getState')).settings;
  const waitWorker = async predicate => {
    const until = Date.now() + 15000;
    while (!await worker.evaluate(predicate)) { if (Date.now() > until) throw new Error('Timed out waiting for the fixture interleaving'); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  await worker.evaluate(async () => {
    globalThis.__blockAccount = true;
    const target = (await chrome.tabs.query({})).filter(t => t.url === 'https://github.com/org/repo/pull/2');
    const ids = new Set(target.map(t => t.id)), groups = new Set(target.map(t => t.groupId));
    const remove = chrome.tabs.remove.bind(chrome.tabs), update = chrome.tabGroups.update.bind(chrome.tabGroups);
    chrome.tabs.remove = async value => { const result = await remove(value); if ((Array.isArray(value) ? value : [value]).some(id => ids.has(id))) globalThis.__handledProtectedPr = true; return result; };
    chrome.tabGroups.update = async (id, patch) => { const result = await update(id, patch); if (groups.has(id)) globalThis.__handledProtectedPr = true; return result; };
  });
  const accountCheck = send('checkConnection', { owner: 'org' });
  await waitWorker(() => !!globalThis.__accountWaiting);
  const protection = send('keepOpen', { key: 'org/repo/2' }).then(value => ({ value }), error => ({ error: String(error) }));
  await send('getState');
  await worker.evaluate(() => { globalThis.__fixture.merged[2] = true; });
  const whileBlocked = send('refresh');
  await waitWorker(() => !!globalThis.__handledProtectedPr);
  const presentWhileBlocked = (await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url === 'https://github.com/org/repo/pull/2');
  await worker.evaluate(() => { globalThis.__blockAccount = false; globalThis.__releaseAccount(); });
  await accountCheck; const protectedResult = await protection; await whileBlocked;
  assert.equal(protectedResult.error, undefined); assert.equal(presentWhileBlocked, true);
  checks.push('Keep open takes effect immediately while a slow credential check holds the command queue.');
  await send('saveSettings', { settings: staleBeforeProtection }); await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url === 'https://github.com/org/repo/pull/2'), true);
  assert.equal((await send('getState')).cleanup.kept.some(pr => pr.key === 'org/repo/2'), true);
  checks.push('Keep open protects all tabs for a PR after merge, and stale category saves cannot undo protection.');
  await popup.getByRole('button', { name: 'Show recently closed PRs', exact: true }).click();
  for (const number of [5, 6]) {
    await popup.getByRole('button', { name: `Reopen and keep open org/repo/${number}`, exact: true }).click();
    await waitForTabs(); await send('refresh');
    assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url === `https://github.com/org/repo/pull/${number}`), true);
  }
  checks.push('Recent closures restore both merged and old-closed PRs with protection before creation, so subsequent checks leave them open.');

  await options.getByRole('button', { name: 'Edit Queued', exact: true }).click();
  await options.screenshot({ path: path.join(artifacts, 'settings.png'), fullPage: true });
  await popup.reload(); await popup.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.screenshot({ path: path.join(artifacts, 'popup.png'), fullPage: true });
  await popup.getByRole('button', { name: 'Show recently closed PRs', exact: true }).click();
  await popup.screenshot({ path: path.join(artifacts, 'popup-cleanup.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 900 });
  await options.screenshot({ path: path.join(artifacts, 'settings-narrow.png'), fullPage: true });
  const overflow = await options.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth).map(e => ({ tag: e.tagName, className: e.className, right: e.getBoundingClientRect().right })).slice(0, 12) }));
  if (overflow.scrollWidth > overflow.width) console.log(JSON.stringify(overflow));
  assert.equal(overflow.scrollWidth <= overflow.width, true);
  assert.deepEqual(errors, []);
  checks.push('Options and popup load without page errors; narrow options layout has no horizontal overflow.');
  const final = await send('getState'); assert.deepEqual(final.status.errors, []);

  const restartFixtures = await worker.evaluate(() => globalThis.__fixture);
  await send('setEnabled', { enabled: false }); await send('refresh');
  await context.close();
  context = await launch();
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture PR</title><p>Restored fixture</p>' }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await installFixtures(restartFixtures);
  options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  const restored = await send('getState');
  assert.deepEqual(restored.cleanup.kept.map(pr => pr.key).sort(), ['org/repo/2', 'org/repo/5', 'org/repo/6']);
  assert.ok(restored.cleanup.recent.some(pr => pr.key === 'org/repo/5'));
  await send('reopenClosed', { key: 'org/repo/5' }); await waitForTabs();
  await send('setEnabled', { enabled: true }); await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url === 'https://github.com/org/repo/pull/5'), true);
  checks.push('A full browser restart preserves cleanup protections and recent history, and restored protection still prevents closure.');
  popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('button', { name: 'Show kept-open PRs', exact: true }).click();
  await popup.getByRole('button', { name: 'Resume cleanup for org/repo/5', exact: true }).click();
  await send('refresh');
  assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).some(t => t.url === 'https://github.com/org/repo/pull/5'), false);
  await popup.getByRole('button', { name: 'Show recently closed PRs', exact: true }).click();
  await popup.getByRole('button', { name: 'Clear history', exact: true }).click();
  const cleaned = await send('getState');
  assert.deepEqual(cleaned.cleanup.recent, []);
  assert.deepEqual(cleaned.cleanup.kept.map(pr => pr.key).sort(), ['org/repo/2', 'org/repo/6']);
  assert.deepEqual(errors, []);
  checks.push('Resume cleanup restores automatic closure; clearing recent history preserves unrelated protections.');
  await writeFile(path.join(artifacts, 'smoke-report.json'), JSON.stringify({ passed: true, environment: 'Isolated headless Chromium; native extension APIs; fixture GitHub responses; no real credentials or user tabs', checks }, null, 2));
  console.log(checks.map((line, i) => `${i + 1}. PASS ${line}`).join('\n'));
} catch (error) {
  const diagnostic = await worker.evaluate(async () => ({ tabs: (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status, groupId: t.groupId })), status: (await chrome.storage.local.get('status')).status })).catch(() => null);
  await writeFile(path.join(artifacts, 'smoke-report.json'), JSON.stringify({ passed: false, checks, error: String(error), pageErrors: errors, diagnostic }, null, 2));
  console.log(JSON.stringify(diagnostic, null, 2));
  throw error;
} finally {
  await context.close();
  if (path.dirname(profile) !== artifacts || !path.basename(profile).startsWith('smoke-profile-')) throw new Error('Invalid cleanup path.');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
