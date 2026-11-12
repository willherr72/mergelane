import { expect, it, vi } from 'vitest';
import { discoverPullRequests, mergeHandledDiscovery, type DiscoveryState } from '../src/background/discovery';
import { defaultSettings } from '../src/core/settings';
import { ApiError } from '../src/github/client';

const pr = (number: number, createdAt = 2000, owner = 'org') => ({ owner, repo: 'repo', number, key: `${owner}/repo/${number}`, createdAt });
function setup(state: DiscoveryState = {}) {
  let time = 1000, current = true;
  const settings = { ...defaultSettings(), enabled: true, connections: [{ owner: 'Org', token: 't' }] };
  const tabs: chrome.tabs.Tab[] = [];
  const create = vi.fn(async (properties: chrome.tabs.CreateProperties) => {
    const tab = { id: tabs.length + 1, windowId: properties.windowId, pendingUrl: properties.url, incognito: false } as chrome.tabs.Tab;
    tabs.push(tab); return tab;
  });
  const browser = { tabs: { query: vi.fn(async () => tabs), create }, windows: { getAll: vi.fn(async () => [{ id: 1, incognito: true, focused: true }, { id: 2, incognito: false, focused: false }]) } } as unknown as Pick<typeof chrome, 'tabs' | 'windows'>;
  const api = { authoredPullRequests: vi.fn(async (_owner: string) => ({ login: 'me', prs: [pr(1, 0)] })), details: vi.fn(async () => ({ state: 'open', merged: false, draft: false, closed_at: null, user: { login: 'me', type: 'User' }, labels: [] })) };
  const save = vi.fn(async () => {});
  const run = (force = true) => discoverPullRequests({ chrome: browser, settings, api, state, save, now: () => time, isCurrent: () => current, force });
  return { settings, state, tabs, create, browser, api, save, run, time: (n: number) => { time = n; }, cancel: () => { current = false; } };
}

it('baselines existing PRs then opens a new authored PR once in a background normal-window tab', async () => {
  const h = setup(); await h.run(); expect(h.create).not.toHaveBeenCalled();
  h.time(3000); h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(1, 0), pr(2)] });
  await h.run();
  expect(h.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/org/repo/pull/2', active: false, windowId: 2 });
  expect(h.api.details).toHaveBeenCalledWith(pr(2), true);
  h.tabs.length = 0;
  const restarted = setup(JSON.parse(JSON.stringify(h.state)));
  restarted.time(90000); restarted.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2)] });
  await restarted.run(); expect(restarted.create).not.toHaveBeenCalled();
});

it('baselines an empty account and skips old PRs exposed later and existing pending subpages', async () => {
  const h = setup(); h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [] }); await h.run();
  h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(1, 0), pr(2)] });
  h.tabs.push({ id: 10, pendingUrl: 'https://github.com/ORG/repo/pull/2/files', incognito: false } as chrome.tabs.Tab);
  await h.run(); expect(h.create).not.toHaveBeenCalled();
  h.tabs.length = 0; await h.run(); expect(h.create).not.toHaveBeenCalled();
});

it('throttles automatic scans, allows manual refresh, and stops while paused or stale', async () => {
  const h = setup(); await h.run(false); await h.run(false);
  expect(h.api.authoredPullRequests).toHaveBeenCalledTimes(1);
  await h.run(); expect(h.api.authoredPullRequests).toHaveBeenCalledTimes(2);
  h.settings.enabled = false; h.time(90000); await h.run();
  expect(h.api.authoredPullRequests).toHaveBeenCalledTimes(2);
  h.settings.enabled = true; h.api.authoredPullRequests.mockImplementation(async () => { h.cancel(); return { login: 'me', prs: [pr(2)] }; });
  await h.run(); expect(h.create).not.toHaveBeenCalled();
});

it('retries failed tab creation and does not let one owner block another', async () => {
  const h = setup(); h.settings.connections.push({ owner: 'other', token: 'b' }); await h.run();
  h.api.authoredPullRequests.mockImplementation(async owner => {
    if (owner.toLowerCase() === 'org') throw new ApiError('Rate limited', 429, 100000);
    return { login: 'me', prs: [pr(2, 2000, 'other')] };
  });
  h.create.mockRejectedValueOnce(new Error('Window disappeared'));
  let result = await h.run(); expect(result.errors).toHaveLength(2); expect(result.retryAt).toBe(100000);
  result = await h.run(); expect(h.create).toHaveBeenCalledTimes(2); expect(result.errors).toHaveLength(1);
});

it('does not open PRs closed since listing, or a PR belonging to another author', async () => {
  const h = setup(); await h.run(); h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2)] });
  h.api.details.mockResolvedValueOnce({ state: 'closed', merged: true, draft: false, closed_at: null, user: { login: 'me', type: 'User' }, labels: [] });
  await h.run(); expect(h.create).not.toHaveBeenCalled();
  h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(3)] });
  h.api.details.mockResolvedValueOnce({ state: 'open', merged: false, draft: false, closed_at: null, user: { login: 'other', type: 'User' }, labels: [] });
  await h.run(); expect(h.create).not.toHaveBeenCalled();
});

it('rechecks live pending URLs after verification and honors cancellation during verification', async () => {
  const h = setup(); await h.run(); h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2)] });
  h.api.details.mockImplementationOnce(async () => {
    h.tabs.push({ id: 2, pendingUrl: 'https://github.com/org/repo/pull/2', incognito: false } as chrome.tabs.Tab);
    return { state: 'open', merged: false, draft: false, closed_at: null, user: { login: 'me', type: 'User' }, labels: [] };
  });
  await h.run(); expect(h.create).not.toHaveBeenCalled();
  h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(3)] });
  h.api.details.mockImplementationOnce(async () => { h.cancel(); return { state: 'open', merged: false, draft: false, closed_at: null, user: { login: 'me', type: 'User' }, labels: [] }; });
  await h.run(); expect(h.create).not.toHaveBeenCalled();
});

it('keeps new PRs pending with no normal window and rebaselines when the account changes', async () => {
  const h = setup(); await h.run(); h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2)] });
  vi.mocked(h.browser.windows.getAll).mockImplementationOnce(async () => []);
  await h.run(); expect(h.create).not.toHaveBeenCalled();
  await h.run(); expect(h.create).toHaveBeenCalledTimes(1);
  h.api.authoredPullRequests.mockResolvedValue({ login: 'new-account', prs: [pr(3)] });
  await h.run(); expect(h.create).toHaveBeenCalledTimes(1);
});

it('continues discovering newer PRs after an individual PR becomes inaccessible', async () => {
  const h = setup(); await h.run();
  h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2), pr(3)] });
  h.api.details.mockRejectedValueOnce(new ApiError('Repository unavailable', 404));
  const result = await h.run();
  expect(result.errors).toHaveLength(1);
  expect(h.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/org/repo/pull/3', active: false, windowId: 2 });
  await h.run(); expect(h.create).toHaveBeenCalledTimes(2);
});

it('persists a completed creation even when pause invalidates the run during tabs.create', async () => {
  const h = setup(); await h.run(); h.save.mockClear();
  h.api.authoredPullRequests.mockResolvedValue({ login: 'me', prs: [pr(2), pr(3)] });
  h.create.mockImplementationOnce(async () => { h.cancel(); return { id: 99 } as chrome.tabs.Tab; });
  await h.run();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ org: expect.objectContaining({ seen: ['org/repo/2'] }) }), { owner: 'org', login: 'me', baselineAt: 1000, key: 'org/repo/2' });
});

it('merges completed outcomes without restoring removed connections or overwriting a new baseline/account', () => {
  const handled = { owner: 'org', login: 'me', baselineAt: 1000, key: 'org/repo/2' };
  const current: DiscoveryState = { org: { login: 'me', baselineAt: 1000, attemptedAt: 9000, seen: ['org/repo/3'] } };
  mergeHandledDiscovery(current, handled); mergeHandledDiscovery(current, handled);
  expect(current.org.seen).toEqual(['org/repo/3', 'org/repo/2']);
  expect(current.org.attemptedAt).toBe(9000);
  const removed: DiscoveryState = {}; mergeHandledDiscovery(removed, handled); expect(removed).toEqual({});
  for (const changed of [{ login: 'new', baselineAt: 1000 }, { login: 'me', baselineAt: 2000 }]) {
    const state: DiscoveryState = { org: { ...changed, attemptedAt: 9000, seen: [] } };
    mergeHandledDiscovery(state, handled); expect(state.org.seen).toEqual([]);
  }
});
