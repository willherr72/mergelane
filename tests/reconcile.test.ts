import { expect, it } from 'vitest';
import { reconcile } from '../src/background/reconcile';
import { defaultSettings } from '../src/core/settings';
import { emptyOwnership, type Snapshot } from '../src/core/model';

const url = (id = 1) => `https://github.com/org/repo/pull/${id}`;
const snapshot = (patch: object = {}): Snapshot => ({ details: { state: 'open', merged: false, closed_at: null, draft: false, user: { login: 'author', type: 'User' }, labels: [], ...patch }, comments: [], reviewComments: [], reviews: [] });
function browser(input: Partial<chrome.tabs.Tab>[]) {
  const tabs = input.map((t, i) => ({ id: i + 1, windowId: 1, groupId: -1, pinned: false, incognito: false, index: i, url: url(), ...t })) as chrome.tabs.Tab[];
  const groups: chrome.tabGroups.TabGroup[] = [], moved: number[] = [];
  let nextGroup = 10;
  const api = {
    tabs: {
      query: async (q: any) => tabs.filter(t => (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId)).map(t => ({ ...t })),
      get: async (id: number) => { const t = tabs.find(t => t.id === id); if (!t) throw new Error('Missing tab'); return { ...t }; },
      remove: async (ids: number | number[]) => { for (const id of Array.isArray(ids) ? ids : [ids]) { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); } },
      ungroup: async (ids: number | number[]) => { tabs.filter(t => (Array.isArray(ids) ? ids : [ids]).includes(t.id!)).forEach(t => t.groupId = -1); },
      group: async (arg: any) => {
        const id = arg.groupId ?? nextGroup++;
        if (!groups.some(g => g.id === id)) groups.push({ id, windowId: arg.createProperties.windowId, title: '', color: 'grey', collapsed: false, shared: false });
        for (const t of tabs.filter(t => arg.tabIds.includes(t.id))) t.groupId = id;
        return id;
      },
    },
    tabGroups: {
      get: async (id: number) => { const g = groups.find(g => g.id === id); if (!g) throw new Error('Missing group'); return { ...g }; },
      update: async (id: number, patch: any) => Object.assign(groups.find(g => g.id === id)!, patch),
      move: async (id: number) => { moved.push(id); return groups.find(g => g.id === id)!; },
    },
  };
  return { api: api as unknown as Pick<typeof chrome, 'tabs' | 'tabGroups'>, tabs, groups, moved };
}
function setup(input: Partial<chrome.tabs.Tab>[] = [{}]) {
  const b = browser(input), settings = defaultSettings(), ownership = emptyOwnership();
  settings.enabled = true; settings.token = 'fixture';
  const fetched: string[] = [];
  const api = { snapshot: async (r: any) => { fetched.push(r.key); return snapshot(); }, details: async (_r: any, _fresh: boolean) => snapshot().details };
  const deps = { chrome: b.api, settings, ownership, api, isCurrent: () => true, now: () => Date.parse('2026-11-10T18:00:00Z') };
  return { ...b, settings, ownership, fetched, apiClient: api, deps };
}

it('deduplicates API checks, keeps window-local groups, and restores ownership after worker restarts', async () => {
  const t = setup([{}, { url: url() + '/files' }, { windowId: 2 }]);
  await reconcile(t.deps);
  expect(t.fetched).toEqual(['org/repo/1']);
  expect(t.groups).toHaveLength(2);
  expect(t.tabs[0].groupId).toBe(t.tabs[1].groupId);
  expect(t.tabs[2].groupId).not.toBe(t.tabs[0].groupId);
  t.groups[0].collapsed = true;
  await reconcile({ ...t.deps, ownership: structuredClone(t.ownership) });
  expect(t.groups).toHaveLength(2);
  expect(t.groups[0].collapsed).toBe(true);
});

it('closes confirmed merged tabs including pinned duplicates, but preserves unrelated tabs', async () => {
  const t = setup([{}, { pinned: true }, { url: 'https://github.com/org/repo/issues/1' }]);
  let fresh = false;
  t.apiClient.snapshot = async () => snapshot({ state: 'closed', merged: true });
  t.apiClient.details = async (_r, isFresh) => { fresh = isFresh; return snapshot({ state: 'closed', merged: true }).details; };
  const result = await reconcile(t.deps);
  expect(fresh).toBe(true);
  expect(t.tabs.map(t => t.id)).toEqual([3]);
  expect(result.closed).toBe(2);
});

it('cancels closure when a closed PR is reopened before the fresh check', async () => {
  const t = setup();
  t.apiClient.snapshot = async () => snapshot({ state: 'closed', closed_at: '2026-11-10T16:00:00Z' });
  await reconcile(t.deps);
  expect(t.tabs).toHaveLength(1);
});

it('does not close tabs on fresh-check errors or after they navigate away', async () => {
  const t = setup();
  t.apiClient.snapshot = async () => snapshot({ state: 'closed', merged: true });
  t.apiClient.details = async () => { throw new Error('Offline'); };
  expect((await reconcile(t.deps)).errors).toHaveLength(1);
  expect(t.tabs).toHaveLength(1);
  t.apiClient.details = async () => { t.tabs[0].url = 'https://example.com'; return snapshot({ state: 'closed', merged: true }).details; };
  await reconcile(t.deps);
  expect(t.tabs).toHaveLength(1);
});

it('leaves prior classification on incomplete data and cancels mutations after settings change', async () => {
  const t = setup();
  await reconcile(t.deps);
  const oldGroup = t.tabs[0].groupId;
  t.apiClient.snapshot = async () => { throw new Error('incomplete'); };
  await reconcile(t.deps);
  expect(t.tabs[0].groupId).toBe(oldGroup);
  t.apiClient.snapshot = async () => { t.deps.isCurrent = () => false; return snapshot({ labels: [{ name: 'mergify-queue' }] }); };
  await reconcile({ ...t.deps, isCurrent: () => t.deps.isCurrent() });
  expect(t.tabs[0].groupId).toBe(oldGroup);
});

it('keeps pinned PRs ungrouped and ignores incognito tabs', async () => {
  const t = setup([{ pinned: true }, { incognito: true, url: url(2) }]);
  await reconcile(t.deps);
  expect(t.groups).toHaveLength(0);
  expect(t.fetched).toEqual(['org/repo/1']);
});

it('renames owned groups without claiming unrelated same-name groups or moving foreign members', async () => {
  const t = setup([{}, { url: url(2) }, { url: 'https://example.com' }]);
  t.apiClient.snapshot = async r => snapshot({ labels: r.number === 1 ? [{ name: 'mergify-queue' }] : [] });
  await reconcile(t.deps);
  t.tabs[2].groupId = t.tabs[0].groupId;
  t.settings.categories.find(c => c.id === 'merging')!.name = 'Queue';
  t.settings.categories.reverse(); t.moved.length = 0;
  await reconcile(t.deps);
  expect(t.groups.find(g => g.id === t.tabs[0].groupId)?.title).toBe('Queue');
  expect(t.moved).not.toContain(t.tabs[2].groupId);
  expect(t.tabs[2].url).toBe('https://example.com');
});

it('releases a tracked tab that leaves GitHub only from an owned group', async () => {
  const t = setup(); await reconcile(t.deps);
  t.tabs[0].url = 'https://example.com';
  await reconcile(t.deps);
  expect(t.tabs[0].groupId).toBe(-1);
  expect(t.ownership.tabs).toEqual({});
});

it('does not regroup a tab with a pending navigation to another PR', async () => {
  const t = setup();
  t.apiClient.snapshot = async () => { t.tabs[0].pendingUrl = url(9); return snapshot(); };
  await reconcile(t.deps);
  expect(t.tabs[0].groupId).toBe(-1);
});

it('leaves loading tabs untouched even when a new pending URL is hidden by host permissions', async () => {
  const t = setup([{ status: 'loading' }]);
  await reconcile(t.deps);
  expect(t.tabs[0].groupId).toBe(-1);
  t.apiClient.snapshot = async () => snapshot({ state: 'closed', merged: true });
  t.apiClient.details = async () => snapshot({ state: 'closed', merged: true }).details;
  await reconcile(t.deps);
  expect(t.tabs).toHaveLength(1);
});

it('does not reorder a group containing a tracked PR that is navigating away', async () => {
  const t = setup([{}, { url: url(2) }]);
  t.apiClient.snapshot = async r => snapshot({ labels: r.number === 1 ? [{ name: 'mergify-queue' }] : [] });
  await reconcile(t.deps);
  t.moved.length = 0;
  t.tabs[1].status = 'loading'; t.tabs[1].pendingUrl = 'https://example.com/';
  // Actual tab order is merging then progress; configured order is the reverse.
  await reconcile(t.deps);
  expect(t.moved).toEqual([]);
});
