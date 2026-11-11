import { expect, it } from 'vitest';
import { OwnerClient } from '../src/github/owners';
import { defaultSettings } from '../src/core/settings';

const ref = (owner: string) => ({ owner, repo: 'repo', number: 1, key: `${owner.toLowerCase()}/repo/1` });
const detail = { state: 'open', merged: false, closed_at: null, draft: false, user: null, labels: [] };
const json = () => new Response(JSON.stringify(detail), { headers: { etag: 'one' } });

it('routes owners case-insensitively, falls back to a legacy token, and rejects unconnected owners', async () => {
  const settings = { ...defaultSettings(), token: 'legacy', connections: [{ owner: 'Org', token: 'org-token' }] };
  const seen: string[] = [];
  const api = new OwnerClient(settings, [], async (_url, init) => { seen.push(new Headers(init?.headers).get('Authorization')!); return json(); });
  await api.details(ref('ORG'), true); await api.details(ref('personal'), true);
  expect(seen).toEqual(['Bearer org-token', 'Bearer legacy']);
  await expect(new OwnerClient({ ...settings, token: '' }, []).details(ref('missing'), true)).rejects.toThrow('Connect missing');
});

it('persists separate retry windows and keeps a healthy owner working after worker restart', async () => {
  const settings = { ...defaultSettings(), connections: [{ owner: 'a', token: 'a-token' }, { owner: 'b', token: 'b-token' }] };
  const api = new OwnerClient(settings, [], async url => String(url).includes('/repos/a/') ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : json(), () => 1000);
  await expect(api.details(ref('a'), true)).rejects.toThrow('rate limit');
  await api.details(ref('b'), true);
  const requests: string[] = [];
  const restarted = new OwnerClient(settings, api.exportCaches(), async url => { requests.push(String(url)); return json(); }, () => 2000);
  await expect(restarted.details(ref('a'), true)).rejects.toThrow('retry');
  await restarted.details(ref('b'), true);
  expect(requests).toHaveLength(1); expect(requests[0]).toContain('/repos/b/');
});
