import { expect, it } from 'vitest';
import { GitHubClient, emptyCache } from '../src/github/client';

const ref = { owner: 'org', repo: 'repo', number: 1, key: 'org/repo/1' };
const detail = { state: 'open', merged: false, closed_at: null, draft: false, user: { login: 'author', type: 'User' }, labels: [{ name: 'ready' }], title: 'Example', body: 'Do not cache this' };
const json = (value: unknown, headers: Record<string,string> = {}) => new Response(JSON.stringify(value), { headers });

it('fetches full paginated feedback and normalizes cached payloads', async () => {
  const requested: string[] = [];
  const cache = emptyCache();
  const client = new GitHubClient('fixture-token', cache, async (url, options) => {
    requested.push(String(url));
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-token');
    expect(options?.redirect).toBe('error');
    if (String(url).endsWith('/pulls/1')) return json(detail);
    if (String(url).includes('/issues/1/comments') && !String(url).includes('page=2')) return json([{ user: { login: 'bot', type: 'Bot' }, body: 'private body' }], { link: '<https://api.github.com/repos/org/repo/issues/1/comments?per_page=100&page=2>; rel="next"' });
    if (String(url).includes('page=2')) return json([{ user: { login: 'alice', type: 'User' } }]);
    return json([]);
  });
  const result = await client.snapshot(ref);
  expect(result.comments.map(c => c.user?.login)).toEqual(['bot', 'alice']);
  expect(requested).toHaveLength(5);
  expect(JSON.stringify(cache)).not.toContain('private body');
  expect(JSON.stringify(cache)).not.toContain('fixture-token');
});

it('uses ETags only for the same credential and bypasses them for closure verification', async () => {
  const cache = emptyCache();
  const headers: (string|null)[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    const etag = new Headers(options?.headers).get('If-None-Match'); headers.push(etag);
    return etag ? new Response(null, { status: 304 }) : json(detail, { etag: 'one' });
  };
  const client = new GitHubClient('one', cache, fetcher);
  await client.details(ref); await client.details(ref); await client.details(ref, true);
  await new GitHubClient('two', cache, fetcher).details(ref);
  expect(headers).toEqual([null, 'one', null, null]);
});

it('refuses foreign pagination and redirects without sending credentials to another host', async () => {
  const requested: string[] = [];
  const client = new GitHubClient('secret', emptyCache(), async url => {
    requested.push(String(url));
    if (String(url).endsWith('/pulls/1')) return json(detail);
    return json([], { link: '<https://evil.test/steal>; rel="next"' });
  });
  await expect(client.snapshot(ref)).rejects.toThrow('pagination');
  expect(requested.every(url => url.startsWith('https://api.github.com/'))).toBe(true);
});

it.each([401, 403, 404, 429, 500])('reports HTTP %s without leaking response bodies', async status => {
  const client = new GitHubClient('secret', emptyCache(), async () => new Response('secret body', { status }), () => 1000);
  try { await client.details(ref); throw new Error('Expected rejection'); } catch (e: any) {
    expect(e.status).toBe(status);
    expect(e.message).not.toContain('secret');
    if (status === 429 || status === 500) expect(e.retryAt).toBeGreaterThan(1000);
  }
});

it('honors retry-after and rejects incomplete or malformed payloads', async () => {
  const limited = new GitHubClient('t', emptyCache(), async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }), () => 1000);
  await expect(limited.details(ref)).rejects.toMatchObject({ retryAt: 121000 });
  const broken = new GitHubClient('t', emptyCache(), async () => json({ state: 'closed', merged: true }));
  await expect(broken.details(ref)).rejects.toThrow('incomplete');
  const uncached = new GitHubClient('t', emptyCache(), async () => new Response(null, { status: 304 }));
  await expect(uncached.details(ref)).rejects.toThrow('cache');
});
