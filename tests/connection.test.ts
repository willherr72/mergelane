import { expect, it } from 'vitest';
import { tokenCreationUrl, verifyConnection } from '../src/github/connection';
import { GitHubClient, emptyCache } from '../src/github/client';

const ref = { owner: 'Example-Org', repo: 'repo', number: 123, key: 'example-org/repo/123' };
const detail = { state: 'open', merged: false, closed_at: null, draft: false, user: { login: 'author', type: 'User' }, labels: [] };
const json = (value: unknown) => new Response(JSON.stringify(value));

it('prefills the resource owner and only the required read permissions', () => {
  const url = new URL(tokenCreationUrl('Example-Org'));
  expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
  expect(Object.fromEntries(url.searchParams)).toEqual({ name: 'MergeLane', target_name: 'Example-Org', pull_requests: 'read', issues: 'read' });
  expect(new URL(tokenCreationUrl('')).searchParams.has('target_name')).toBe(false);
});

it('rejects a valid account token that cannot read the organization PR', async () => {
  const client = new GitHubClient('fixture', emptyCache(), async url => String(url).endsWith('/user') ? json({ login: 'personal-account' }) : new Response('', { status: 404 }));
  await expect(verifyConnection(client, [ref], 'Example-Org')).rejects.toThrow(/Resource owner.*Example-Org/);
});

it('checks comments and reviews, deduplicates tabs, and scopes the result to the chosen owner', async () => {
  const paths: string[] = [];
  const client = new GitHubClient('fixture', emptyCache(), async url => {
    const path = new URL(String(url)).pathname; paths.push(path);
    return json(path === '/user' ? { login: 'personal-account' } : path.endsWith('/123') ? detail : []);
  });
  const report = await verifyConnection(client, [ref, ref, { ...ref, owner: 'other', key: 'other/repo/123' }], 'example-org');
  expect(report).toEqual({ login: 'personal-account', owner: 'example-org', checked: 1 });
  expect(paths).toHaveLength(5);
  expect(paths).toContain('/repos/Example-Org/repo/issues/123/comments');
  expect(paths).toContain('/repos/Example-Org/repo/pulls/123/reviews');
});

it('does not claim repository verification with no matching open tabs', async () => {
  const client = new GitHubClient('fixture', emptyCache(), async () => json({ login: 'personal-account' }));
  expect(await verifyConnection(client, [], '')).toEqual({ login: 'personal-account', owner: '', checked: 0 });
});

it('rejects missing comment permissions even when PR details are readable', async () => {
  const client = new GitHubClient('fixture', emptyCache(), async url => String(url).endsWith('/user') ? json({ login: 'personal-account' }) : String(url).endsWith('/123') ? json(detail) : new Response('', { status: 403 }));
  await expect(verifyConnection(client, [ref], ref.owner)).rejects.toThrow(/Issues.*Read-only/);
});

it('keeps rate limit errors actionable instead of misdiagnosing owner permissions', async () => {
  const client = new GitHubClient('fixture', emptyCache(), async url => String(url).endsWith('/user') ? json({ login: 'personal-account' }) : new Response('', { status: 403, headers: { 'retry-after': '60' } }));
  await expect(verifyConnection(client, [ref], ref.owner)).rejects.toThrow('rate limit');
});

it('checks comment permissions even when the test PR is already closed', async () => {
  const client = new GitHubClient('fixture', emptyCache(), async url => String(url).endsWith('/user') ? json({ login: 'personal-account' }) : String(url).endsWith('/123') ? json({ ...detail, state: 'closed', closed_at: '2026-11-10T00:00:00Z' }) : new Response('', { status: 403 }));
  await expect(verifyConnection(client, [ref], ref.owner)).rejects.toThrow(/Issues.*Read-only/);
});
