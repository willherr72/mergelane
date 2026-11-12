import type { PrDetails, PrRef, Settings } from '../core/model';
import { parsePrUrl } from '../core/url';
import { ApiError, type AuthoredPullRequests } from '../github/client';

interface OwnerDiscovery {
  login?: string;
  baselineAt?: number;
  seen: string[];
  attemptedAt: number;
  error?: { message: string; retryAt: number | null };
}
export type DiscoveryState = Record<string, OwnerDiscovery>;
export interface HandledDiscovery { owner: string; login: string; baselineAt: number; key: string }
// Merge only an observed outcome into current state, never a stale full snapshot.
export function mergeHandledDiscovery(state: DiscoveryState, handled: HandledDiscovery): void {
  const saved = Object.hasOwn(state, handled.owner) ? state[handled.owner] : undefined;
  if (saved?.login === handled.login && saved.baselineAt === handled.baselineAt && !saved.seen.includes(handled.key)) saved.seen.push(handled.key);
}
interface DiscoveryDeps {
  chrome: Pick<typeof chrome, 'tabs' | 'windows'>;
  settings: Settings;
  state: DiscoveryState;
  api: {
    authoredPullRequests(owner: string): Promise<AuthoredPullRequests>;
    details(ref: PrRef, fresh: boolean): Promise<PrDetails>;
  };
  save(state: DiscoveryState, handled?: HandledDiscovery): Promise<void>;
  now(): number;
  isCurrent(): boolean;
  force?: boolean;
}

export async function discoverPullRequests(deps: DiscoveryDeps) {
  const { chrome: browser, settings, api, state, isCurrent, now } = deps;
  const result = { errors: [] as { pr: string; message: string }[], retryAt: null as number | null };
  if (!settings.enabled || !isCurrent()) return result;
  const persist = async (handled?: HandledDiscovery) => { if (isCurrent() || handled) await deps.save(state, handled); };
  const failure = (error: unknown) => ({ message: error instanceof ApiError ? error.message : 'Could not open new PR tabs. MergeLane will retry automatically.', retryAt: error instanceof ApiError ? error.retryAt : null });
  const existing = async (key: string) => (await browser.tabs.query({ windowType: 'normal' })).some(tab => !tab.incognito && parsePrUrl(tab.pendingUrl || tab.url)?.key === key);
  for (const connection of settings.connections) {
    if (!isCurrent()) break;
    if (!connection.token) continue;
    const owner = connection.owner.toLowerCase(), startedAt = now();
    let saved = Object.hasOwn(state, owner) ? state[owner] : undefined;
    if (deps.force || !saved || startedAt - saved.attemptedAt >= 60000) {
      try {
        const found = await api.authoredPullRequests(owner);
        if (!isCurrent()) break;
        if (!saved || saved.baselineAt === undefined || saved.login !== found.login.toLowerCase()) {
          const baselineAt = Math.floor(startedAt / 1000) * 1000;
          saved = { login: found.login.toLowerCase(), baselineAt, seen: found.prs.filter(pr => pr.createdAt >= baselineAt).map(pr => pr.key), attemptedAt: startedAt };
          state[owner] = saved;
          await persist();
          continue;
        }
        saved.attemptedAt = startedAt;
        delete saved.error;
        const handled = new Set(saved.seen);
        for (const pr of found.prs) {
          if (!isCurrent()) break;
          if (pr.owner.toLowerCase() !== owner || pr.createdAt < saved.baselineAt || handled.has(pr.key)) continue;
          try {
            let present = await existing(pr.key);
            if (!isCurrent()) break;
            if (!present) {
              const detail = await api.details(pr, true);
              if (!isCurrent()) break;
              if (detail.state === 'open' && !detail.merged && detail.user?.login.toLowerCase() === saved.login) {
                const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
                const eligible = windows.filter(window => !window.incognito && window.id !== undefined);
                const target = eligible.find(window => window.focused) ?? eligible[0];
                if (!target) continue;
                present = await existing(pr.key);
                if (!isCurrent()) break;
                if (!present) await browser.tabs.create({ url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, active: false, windowId: target.id! });
              }
            }
            handled.add(pr.key); saved.seen = [...handled];
            // Save after each creation so worker suspension cannot lose the batch.
            await persist({ owner, login: saved.login!, baselineAt: saved.baselineAt, key: pr.key });
          } catch (error) {
            if (!isCurrent()) break;
            // Authentication and backoff apply to the connection. A missing PR
            // or disappeared window must not starve later PRs in this batch.
            if (error instanceof ApiError && (error.retryAt || error.status === 401)) throw error;
            saved.error ??= failure(error);
          }
        }
      } catch (error) {
        if (!isCurrent()) break;
        saved ??= { seen: [], attemptedAt: startedAt };
        saved.attemptedAt = startedAt;
        saved.error = failure(error);
      }
      if (saved) { state[owner] = saved; await persist(); }
    }
    if (saved?.error) {
      result.errors.push({ pr: `${owner}/discovery`, message: `New PR discovery: ${saved.error.message}` });
      if (saved.error.retryAt) result.retryAt = Math.max(result.retryAt ?? 0, saved.error.retryAt);
    }
  }
  return result;
}
