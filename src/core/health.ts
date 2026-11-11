import type { RunStatus, Settings } from './model';

export interface ConnectionHealth { owner: string; status: 'verified' | 'account-only' | 'error'; checkedAt: number; message: string }
export function putHealth(items: ConnectionHealth[], health: ConnectionHealth): ConnectionHealth[] {
  return [...items.filter(item => item.owner.toLowerCase() !== health.owner.toLowerCase()), { ...health, owner: health.owner.toLowerCase() }];
}
export function healthFromRun(items: ConnectionHealth[], settings: Settings, status: RunStatus, now: number): ConnectionHealth[] {
  const explicit = new Set(settings.connections.map(c => c.owner.toLowerCase()));
  for (const owner of [...explicit, ...(settings.token ? [''] : [])]) {
    const matches = (candidate: string) => owner ? candidate.toLowerCase() === owner : !explicit.has(candidate.toLowerCase());
    if (!status.owners.some(matches)) continue;
    const error = status.errors.find(e => matches(e.pr.split('/')[0]));
    items = putHealth(items, { owner, status: error ? 'error' : 'verified', checkedAt: now, message: error?.message ?? 'Access verified for open PR tabs.' });
  }
  return items;
}
