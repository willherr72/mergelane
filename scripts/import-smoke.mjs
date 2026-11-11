import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const profile = path.resolve(artifacts, `import-profile-${Date.now()}`);
const checks = [], pageErrors = [];
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 }, args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`] });
context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(20000);
context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
const tokenFor = owner => `github_pat_${owner.replaceAll('-', '_')}_${'f'.repeat(60)}`;
await context.route('https://github.com/**', async route => {
  const url = new URL(route.request().url());
  const owner = url.searchParams.get('target_name') || 'org-a';
  const html = `<!doctype html><title>Isolated GitHub fixture</title><main><h1>Generate token for ${owner}</h1><button id="generate">Generate token</button></main><script>document.getElementById('generate').onclick=()=>{history.pushState({},'', '/settings/personal-access-tokens/123'); document.body.replaceChildren();const main=document.createElement('main');const input=document.createElement('input');input.id='new-access-token';input.readOnly=true;input.value=${JSON.stringify(tokenFor(owner))};main.append(input);document.body.append(main);};</script>`;
  await route.fulfill({ contentType: 'text/html', body: url.pathname.startsWith('/settings/') ? html : '<!doctype html><title>PR fixture</title><p>Isolated PR</p>' });
});
let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
async function fixtures() {
  await worker.evaluate(() => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture host');
      const json = value => new Response(JSON.stringify(value));
      if (url.pathname === '/user') return json({ login: 'fixture-user' });
      const owner = url.pathname.split('/')[2];
      if (globalThis.__holdOwner === owner) {
        globalThis.__waitingForRelease = true;
        await new Promise(resolve => { globalThis.__releaseRequest = resolve; });
      }
      const token = new Headers(init?.headers).get('Authorization');
      if (!token?.startsWith(`Bearer github_pat_${owner.replaceAll('-', '_')}_`)) return new Response('', { status: 404 });
      if (/\/pulls\/\d+$/.test(url.pathname)) return json({ state: 'open', merged: false, closed_at: null, draft: false, user: { login: 'author', type: 'User' }, labels: owner === 'org-b' ? [{ name: 'mergify-queue' }] : [] });
      if (url.pathname.includes('/issues/')) return json([{ user: { login: 'reviewer', type: 'User' } }]);
      return json([]);
    };
  });
}
async function isolatedMessage(page, request, expression) {
  const cdp = await context.newCDPSession(page);
  const worlds = []; cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
  await cdp.send('Runtime.enable');
  let world;
  for (const candidate of worlds) {
    if (candidate.auxData?.isDefault) continue;
    const identity = await cdp.send('Runtime.evaluate', { contextId: candidate.id, expression: 'globalThis.chrome?.runtime?.id', returnByValue: true });
    if (identity.result.value === id) { world = candidate; break; }
  }
  assert.ok(world, 'The real extension content-script world exists');
  const result = await cdp.send('Runtime.evaluate', { contextId: world.id, expression: expression ?? `chrome.runtime.sendMessage(${JSON.stringify(request)}).then(value => value ?? null).catch(() => null)`, awaitPromise: true, returnByValue: true });
  await cdp.detach(); return result.result.value;
}

try {
  await fixtures();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  const send = (type, data = {}) => options.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ type, ...data }); if (!reply.ok) throw new Error(reply.error); return reply.data;
  }, { type, data });
  await options.getByRole('button', { name: 'Add connection', exact: true }).waitFor();
  for (const owner of ['org-a', 'org-b']) { const pr = await context.newPage(); await pr.goto(`https://github.com/${owner}/repo/pull/1`); }
  await options.reload();
  async function start(owner) {
    await options.getByRole('button', { name: 'Add connection', exact: true }).click();
    assert.equal(await options.getByLabel('Resource owner', { exact: true }).inputValue(), '');
    const suggestion = options.getByRole('button', { name: `Use detected owner ${owner}`, exact: true });
    if (await suggestion.count()) await suggestion.click();
    else await options.getByLabel('Resource owner', { exact: true }).fill(owner);
    const created = context.waitForEvent('page', { predicate: async page => {
      try {
        await page.waitForURL(url => url.origin === 'https://github.com' && url.pathname === '/settings/personal-access-tokens/new' && url.searchParams.get('target_name') === owner);
        return true;
      } catch { return false; }
    } });
    await options.getByRole('link', { name: `Create token for ${owner}`, exact: true }).click();
    const page = await created;
    await page.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
    return page;
  }
  const a = await start('org-a');
  await a.locator('#mergelane-token-import').screenshot({ path: path.join(artifacts, 'assisted-import.png') });
  await a.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await a.getByRole('status').filter({ hasText: 'could not find' }).waitFor();
  assert.equal((await send('getState')).hasToken, false);
  await a.getByRole('button', { name: 'Generate token', exact: true }).click();
  await a.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
  await a.evaluate(() => document.querySelector('#mergelane-token-import').shadowRoot.querySelector('button').click());
  assert.equal((await send('getState')).hasToken, false);
  assert.equal(await isolatedMessage(a, { type: 'getState' }), null);
  assert.equal(await isolatedMessage(a, null, "chrome.storage.local.get('settings').then(() => false).catch(() => true)"), true);
  checks.push('The helper waits for a real click and a generated token, and cannot read extension state or trusted local storage.');

  const unrelated = await context.newPage(); await unrelated.goto('https://github.com/settings/personal-access-tokens/new');
  await unrelated.waitForLoadState('load');
  assert.deepEqual(await isolatedMessage(unrelated, { type: 'importContext' }), { ok: true, data: null });
  const denied = await isolatedMessage(unrelated, { type: 'importToken', token: tokenFor('org-a') });
  assert.equal(denied.ok, false); assert.match(denied.error, /session has ended/);
  assert.equal(await unrelated.locator('#mergelane-token-import').count(), 0);
  checks.push('An unrelated GitHub token-settings tab cannot obtain an import grant or store a credential.');

  // Session storage survives a genuine service-worker stop/wake.
  const cdp = await context.newCDPSession(options);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await send('getState');
  worker = context.serviceWorkers().find(w => w.url().includes(id)) ?? worker; await fixtures();
  await a.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await a.getByRole('button', { name: 'Imported', exact: true }).waitFor();
  let state = await send('getState');
  assert.deepEqual(state.settings.connections, [{ owner: 'org-a', token: '' }]);
  assert.equal(state.settings.enabled, false); assert.equal(state.settings.token, '');
  const replay = await isolatedMessage(a, { type: 'importToken', token: tokenFor('org-a') });
  assert.equal(replay.ok, false);
  checks.push('Explicit import verifies PR access after worker restart, omits tokens from public state, stays paused, and rejects replay.');

  const b = await start('org-b'); await b.getByRole('button', { name: 'Generate token', exact: true }).click();
  await b.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
  await b.locator('#new-access-token').evaluate((input, value) => { input.value = value; }, tokenFor('wrong-owner'));
  await b.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await b.getByRole('status').filter({ hasText: 'Cannot read org-b/repo' }).waitFor();
  assert.deepEqual((await send('getState')).settings.connections.map(c => c.owner), ['org-a']);
  await b.locator('#new-access-token').evaluate((input, value) => { input.value = value; }, tokenFor('org-b'));
  await b.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await b.getByRole('button', { name: 'Imported', exact: true }).waitFor();
  assert.deepEqual((await send('getState')).settings.connections.map(c => c.owner), ['org-a', 'org-b']);
  checks.push('Failed owner verification preserves existing connections and allows a successful explicit retry.');

  await send('setToken', { owner: '', token: tokenFor('org-a') });
  assert.equal((await send('checkConnection', { owner: '' })).connectionCheck.checked, 0);
  await send('removeConnection', { owner: 'org-a' });
  assert.equal((await send('checkConnection', { owner: '' })).connectionCheck.checked, 1);
  await assert.rejects(send('setToken', { owner: 'org-a', token: tokenFor('org-a'), mode: 'replace' }), /removed/);
  await send('setToken', { owner: 'org-a', token: tokenFor('org-a'), mode: 'add' });
  await assert.rejects(send('setToken', { owner: 'ORG-A', token: tokenFor('org-b'), mode: 'add' }), /already/);
  await send('removeConnection', { owner: '' });
  checks.push('Default checks exclude explicitly connected owners; stale Replace and duplicate Add requests cannot recreate or overwrite connections.');

  await send('setEnabled', { enabled: true }); await send('refresh');
  let groups = await worker.evaluate(() => chrome.tabGroups.query({}));
  assert.ok(groups.some(g => g.title === 'In Review')); assert.ok(groups.some(g => g.title === 'Merging'));
  assert.deepEqual((await send('getState')).status.errors, []);
  await send('removeConnection', { owner: 'org-a' }); await send('refresh');
  state = await send('getState'); assert.equal(state.settings.enabled, true);
  assert.equal(state.status.errors.length, 1); assert.match(state.status.errors[0].message, /Connect org-a/);
  assert.equal(state.status.counts.merging, 1);
  checks.push('Two owners use their own tokens for native groups; removing one connection leaves the other working.');

  const c = await start('org-c'); await c.getByRole('button', { name: 'Generate token', exact: true }).click();
  await c.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
  await send('disconnect');
  await c.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await c.getByRole('status').filter({ hasText: 'session has ended' }).waitFor();
  assert.equal((await send('getState')).hasToken, false);
  const expired = await start('org-d'); await expired.getByRole('button', { name: 'Generate token', exact: true }).click();
  await expired.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
  await worker.evaluate(async () => {
    const { tokenImports } = await chrome.storage.session.get('tokenImports');
    await chrome.storage.session.set({ tokenImports: tokenImports.map(s => ({ ...s, expiresAt: Date.now() - 1 })) });
  });
  await expired.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  await expired.getByRole('status').filter({ hasText: 'session has ended' }).waitFor();
  assert.equal((await send('getState')).hasToken, false);
  checks.push('Disconnect and session expiry prevent later import from an already-open setup tab.');

  const probe = await context.newPage(); await probe.goto('https://github.com/org-e/repo/pull/1');
  const navigating = await start('org-e'); await navigating.getByRole('button', { name: 'Generate token', exact: true }).click();
  await navigating.getByRole('button', { name: 'Import into MergeLane', exact: true }).waitFor();
  await worker.evaluate(() => { globalThis.__holdOwner = 'org-e'; });
  await navigating.getByRole('button', { name: 'Import into MergeLane', exact: true }).click();
  const deadline = Date.now() + 15000;
  while (!await worker.evaluate(() => !!globalThis.__waitingForRelease)) {
    if (Date.now() > deadline) throw new Error('Expected verification request to start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await navigating.goto('https://github.com/org-e/repo');
  await worker.evaluate(() => { globalThis.__holdOwner = ''; globalThis.__releaseRequest(); });
  // A queued settings operation is a barrier after import verification. It
  // preserves credentials, so it cannot mask an erroneous successful import.
  await send('saveSettings', { settings: (await send('getState')).settings });
  assert.equal((await send('getState')).hasToken, false);
  checks.push('Navigating away during API verification prevents the credential from being saved.');
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(artifacts, 'import-smoke-report.json'), JSON.stringify({ passed: true, environment: 'Isolated native Chromium extension with fixture GitHub token pages/API; no real credentials', checks }, null, 2));
  console.log(checks.map((check, i) => `${i + 1}. PASS ${check}`).join('\n'));
} catch (error) {
  const panels = await Promise.all(context.pages().map(page => page.evaluate(() => document.querySelector('#mergelane-token-import')?.shadowRoot?.querySelector('[role=status]')?.textContent).catch(() => null)));
  const diagnostics = await worker.evaluate(async () => ({ imports: (await chrome.storage.session.get('tokenImports')).tokenImports, tabs: (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status })) })).catch(() => null);
  const toasts = await Promise.all(context.pages().filter(p => p.url().startsWith('chrome-extension:')).map(p => p.locator('#toast').textContent().catch(() => null)));
  await writeFile(path.join(artifacts, 'import-smoke-report.json'), JSON.stringify({ passed: false, checks, error: String(error), pageErrors, panels, diagnostics, toasts }, null, 2));
  throw error;
} finally {
  await context.close();
  if (path.dirname(profile) !== artifacts || !path.basename(profile).startsWith('import-profile-')) throw new Error('Invalid cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
