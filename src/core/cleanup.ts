import { parsePrUrl } from './url';

export interface KeptPr { key: string; url: string; title: string }
export interface ClosedPr extends KeptPr { closedAt: number; reason: 'merged' | 'closed' }
export interface CleanupState { kept: KeptPr[]; recent: ClosedPr[] }
export const emptyCleanup = (): CleanupState => ({ kept: [], recent: [] });
export function canonicalPr(url: string, title: string): KeptPr {
  const ref = parsePrUrl(url);
  if (!ref) throw new Error('Choose a valid GitHub PR.');
  return { key: ref.key, url: `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.number}`, title: title.slice(0, 300) };
}
export function setProtection(state: CleanupState, pr: KeptPr, keep: boolean): CleanupState {
  const canonical = canonicalPr(pr.url, pr.title);
  const kept = state.kept.filter(item => item.key !== canonical.key);
  if (keep) kept.push(canonical);
  if (kept.length > 500) throw new Error('You have 500 protected PRs. Resume cleanup for one before adding another.');
  return { ...state, kept };
}
export function addClosure(state: CleanupState, pr: ClosedPr): CleanupState {
  const entry = { ...canonicalPr(pr.url, pr.title), closedAt: pr.closedAt, reason: pr.reason };
  return { ...state, recent: [entry, ...state.recent.filter(item => item.key !== entry.key)].slice(0, 30) };
}
