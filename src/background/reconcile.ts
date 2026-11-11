import { classify, deriveFacts, explainCategory, shouldClose } from '../core/classify';
import { canonicalPr, type ClosedPr } from '../core/cleanup';
import { parsePrUrl } from '../core/url';
import { emptyStatus, hasCredentials, type Ownership, type PrDetails, type PrRef, type RunStatus, type Settings, type Snapshot } from '../core/model';
import { ApiError } from '../github/client';

export interface ReconcileDeps {
  chrome: Pick<typeof chrome, 'tabs' | 'tabGroups'>;
  settings: Settings;
  ownership: Ownership;
  api: { snapshot(ref: PrRef): Promise<Snapshot>; details(ref: PrRef, fresh: boolean): Promise<PrDetails> };
  isCurrent(): boolean;
  now(): number;
  keptKeys?: Set<string>;
  onClosed?(pr: ClosedPr): Promise<void>;
}

export async function reconcile(deps: ReconcileDeps): Promise<RunStatus> {
  const { chrome: browser, settings, ownership, api, isCurrent, now } = deps;
  const status = { ...emptyStatus(), attemptedAt: now() };
  if (!settings.enabled || !hasCredentials(settings) || !isCurrent()) return status;
  const tabs = (await browser.tabs.query({ windowType: 'normal' })).filter(t => !t.incognito && t.id !== undefined);
  const byId = new Map(tabs.map(t => [t.id!, t]));
  const groupIds = new Set(Object.values(ownership.groups));
  const fallback = settings.categories.find(c => c.fallback)!;
  const jobs = new Map<string, { ref: PrRef; tabs: chrome.tabs.Tab[] }>();
  for (const tab of tabs) {
    const ref = parsePrUrl(tab.url);
    if (!ref) continue;
    if (!jobs.has(ref.key)) jobs.set(ref.key, { ref, tabs: [] });
    jobs.get(ref.key)!.tabs.push(tab);
    status.tracked++;
  }
  status.owners = [...new Set([...jobs.values()].map(job => job.ref.owner.toLowerCase()))];
  function observe(key: string, title: string, categoryId: string | null, explanation: string, checked = true): void {
    const ref = jobs.get(key)!.ref;
    status.prs = status.prs.filter(pr => pr.key !== key);
    status.prs.push({ ...canonicalPr(`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`, title), categoryId, explanation, checkedAt: checked ? now() : null });
  }
  // Forget IDs that disappeared or navigated to another resource. Session
  // storage prevents IDs from a prior browser session being mistaken for ours.
  for (const [id, tracked] of Object.entries(ownership.tabs)) {
    const tab = byId.get(Number(id));
    if (tab && parsePrUrl(tab.url)?.key === tracked.key) continue;
    if (tab && groupIds.has(tab.groupId) && !tab.pinned && isCurrent()) {
      try {
        const live = await browser.tabs.get(tab.id!);
        if (isCurrent() && live.groupId === tab.groupId && parsePrUrl(live.url)?.key !== tracked.key) await browser.tabs.ungroup(tab.id!);
      } catch { /* The tab may have closed. */ }
    }
    delete ownership.tabs[id];
  }
  for (const [key, id] of Object.entries(ownership.groups)) {
    try {
      const group = await browser.tabGroups.get(id);
      if (group.windowId !== Number(key.split(':')[0])) delete ownership.groups[key];
    } catch { delete ownership.groups[key]; }
  }

  type Result = { snapshot: Snapshot } | { error: unknown };
  const results = new Map<string, Result>();
  const pending = [...jobs.values()];
  // Three unique PRs at once; requests within each snapshot are sequential.
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length && isCurrent()) {
      const job = pending.shift()!;
      try { results.set(job.ref.key, { snapshot: await api.snapshot(job.ref) }); }
      catch (error) { results.set(job.ref.key, { error }); }
    }
  }));

  function recordError(key: string, error: unknown): void {
    status.errors.push({ pr: key, message: error instanceof ApiError ? error.message : 'Could not complete this PR check. Its tabs have been left in place.' });
    if (error instanceof ApiError && error.retryAt) status.retryAt = Math.max(status.retryAt ?? 0, error.retryAt);
    observe(key, '', null, 'Could not check this PR. Its previous group is left in place.', false);
  }
  async function liveTab(tab: chrome.tabs.Tab, key: string): Promise<chrome.tabs.Tab | null> {
    if (!isCurrent()) return null;
    try {
      const live = await browser.tabs.get(tab.id!);
      return isCurrent() && live.status !== 'loading' && !live.incognito && live.windowId === tab.windowId && parsePrUrl(live.url)?.key === key && (!live.pendingUrl || parsePrUrl(live.pendingUrl)?.key === key) ? live : null;
    } catch { return null; }
  }
  async function place(tab: chrome.tabs.Tab, key: string, categoryId: string): Promise<boolean> {
    const live = await liveTab(tab, key);
    if (!live) return false;
    const category = settings.categories.find(c => c.id === categoryId) ?? fallback;
    if (!live.pinned) {
      const groupKey = `${live.windowId}:${category.id}`;
      let id = ownership.groups[groupKey];
      if (id !== undefined) {
        try { await browser.tabGroups.get(id); } catch { delete ownership.groups[groupKey]; id = undefined as never; }
      }
      // A URL may change while awaiting group lookup, so check immediately
      // before the actual tab mutation as well.
      const checked = await liveTab(tab, key);
      if (!checked || checked.pinned) return false;
      if (id === undefined) {
        id = await browser.tabs.group({ tabIds: [tab.id!], createProperties: { windowId: live.windowId } });
        ownership.groups[groupKey] = id;
      } else if (checked.groupId !== id) {
        await browser.tabs.group({ groupId: id, tabIds: [tab.id!] });
      }
      ownership.tabs[String(tab.id)] = { key, categoryId: category.id };
      if (isCurrent()) await browser.tabGroups.update(id, { title: category.name, color: category.color });
    } else ownership.tabs[String(tab.id)] = { key, categoryId: category.id };
    return true;
  }

  for (const [key, job] of jobs) {
    if (!isCurrent()) break;
    const result = results.get(key);
    if (!result) continue;
    if ('error' in result) {
      recordError(key, result.error);
      for (const tab of job.tabs) {
        const old = ownership.tabs[String(tab.id)];
        if (old) status.counts[old.categoryId] = (status.counts[old.categoryId] ?? 0) + 1;
      }
      continue;
    }
    try {
      let detail = result.snapshot.details;
      const kept = deps.keptKeys?.has(key) ?? false;
      if (!kept && shouldClose(detail, now())) {
        detail = await api.details(job.ref, true);
        if (!isCurrent()) break;
        if (shouldClose(detail, now())) {
          for (const tab of job.tabs) {
            if (!await liveTab(tab, key)) continue;
            await browser.tabs.remove(tab.id!);
            delete ownership.tabs[String(tab.id)];
            status.closed++;
            await deps.onClosed?.({ ...canonicalPr(`https://github.com/${job.ref.owner}/${job.ref.repo}/pull/${job.ref.number}`, detail.title ?? ''), closedAt: now(), reason: detail.merged ? 'merged' : 'closed' });
          }
          continue;
        }
        // The fresh check reopened or reclosed the PR. Keep its previous
        // classification this cycle rather than use stale feedback facts.
        for (const tab of job.tabs) {
          const categoryId = ownership.tabs[String(tab.id)]?.categoryId ?? fallback.id;
          if (await place(tab, key, categoryId)) status.counts[categoryId] = (status.counts[categoryId] ?? 0) + 1;
        }
        observe(key, detail.title ?? '', null, 'PR changed during this check. Previous group retained until the next check.');
        continue;
      }
      const facts = deriveFacts(result.snapshot, settings.ignoredLogins);
      const openCategory = detail.state === 'open' ? classify(facts, settings) : null;
      for (const tab of job.tabs) {
        const previous = ownership.tabs[String(tab.id)]?.categoryId;
        const categoryId = openCategory ?? (settings.categories.some(c => c.id === previous && c.enabled) ? previous! : fallback.id);
        if (await place(tab, key, categoryId)) status.counts[categoryId] = (status.counts[categoryId] ?? 0) + 1;
        const category = settings.categories.find(c => c.id === categoryId)!;
        const closedAt = detail.closed_at ? Date.parse(detail.closed_at) : NaN;
        const waiting = Number.isFinite(closedAt) && now() >= closedAt && now() - closedAt <= 3600000 ? 'Closed PR within its one-hour grace period; previous lane retained.' : 'Closed PR without a usable closure time; automatic cleanup is waiting.';
        observe(key, detail.title ?? '', categoryId, openCategory ? explainCategory(category, facts) : kept ? `${detail.merged ? 'Merged' : 'Closed'} PR — kept open at your request.` : waiting);
      }
    } catch (error) { recordError(key, error); }
  }

  // Move only whole groups whose every member is currently managed. A user
  // may have manually put an unrelated tab in one of our groups.
  const stableMember = (tab: chrome.tabs.Tab): boolean => {
    const tracked = ownership.tabs[String(tab.id)];
    return !!tracked && tab.status !== 'loading' && !tab.incognito && tracked.key === parsePrUrl(tab.url)?.key && (!tab.pendingUrl || parsePrUrl(tab.pendingUrl)?.key === tracked.key);
  };
  for (const windowId of new Set(tabs.map(t => t.windowId))) {
    if (!isCurrent()) break;
    try {
      const live = await browser.tabs.query({ windowId });
      const present = settings.categories.map(c => ({ category: c, id: ownership.groups[`${windowId}:${c.id}`] })).filter(g => g.id !== undefined).map(g => ({ ...g, tabs: live.filter(t => t.groupId === g.id) })).filter(g => g.tabs.length);
      if (present.some(g => g.tabs.some(t => !stableMember(t)))) continue;
      const actual = [...present].sort((a, b) => Math.min(...a.tabs.map(t => t.index)) - Math.min(...b.tabs.map(t => t.index)));
      if (actual.every((g, i) => g.id === present[i].id)) continue;
      let index = Math.min(...actual.flatMap(g => g.tabs.map(t => t.index)));
      for (const group of present) {
        if (!isCurrent()) break;
        // Recheck membership immediately before moving the group.
        const members = await browser.tabs.query({ groupId: group.id });
        if (!isCurrent() || members.some(t => !stableMember(t))) break;
        await browser.tabGroups.move(group.id, { index });
        index += members.length;
      }
    } catch { /* A tab/window may disappear during reordering; retry next run. */ }
  }
  if (isCurrent() && !status.errors.length) status.checkedAt = now();
  status.tracked -= status.closed;
  return status;
}
