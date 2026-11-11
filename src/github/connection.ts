import type { PrRef, Settings } from '../core/model';
import type { GitHubClient } from './client';

export interface ConnectionCheck { login: string; owner: string; checked: number }
export function verificationRefs(refs: PrRef[], settings: Settings, owner: string): PrRef[] {
  return owner ? refs.filter(ref => ref.owner.toLowerCase() === owner.toLowerCase()) : refs.filter(ref => !settings.connections.some(c => c.owner.toLowerCase() === ref.owner.toLowerCase()));
}

export function tokenCreationUrl(owner: string): string {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.searchParams.set('name', 'MergeLane');
  if (owner.trim()) url.searchParams.set('target_name', owner.trim());
  url.searchParams.set('pull_requests', 'read');
  url.searchParams.set('issues', 'read');
  return url.href;
}

export async function verifyConnection(client: GitHubClient, refs: PrRef[], owner: string): Promise<ConnectionCheck> {
  const login = await client.checkToken();
  const selected = refs.filter(ref => !owner || ref.owner.toLowerCase() === owner.toLowerCase());
  const unique = [...new Map(selected.map(ref => [ref.key, ref])).values()];
  for (const ref of unique) await client.snapshot(ref, true);
  return { login, owner, checked: unique.length };
}

export function repositoryAccessError(owner: string, repo: string): string {
  return `Cannot read ${owner}/${repo}. Check that the PR still exists. For a private repository, set the token's Resource owner to ${owner}, include ${repo}, and grant Pull requests and Issues: Read-only. “All repositories” only covers the selected owner. If approval is pending, an organization admin must approve the token.`;
}
