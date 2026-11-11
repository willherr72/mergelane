import type { Actor, Comment, PrDetails, PrRef, Review, Snapshot } from '../core/model';
import { repositoryAccessError } from './connection';

interface Entry { data: unknown; etag: string | null; next: string | null; usedAt: number }
export interface RequestCache { scope: string; entries: Record<string, Entry> }
export const emptyCache = (): RequestCache => ({ scope: '', entries: {} });
export class ApiError extends Error {
  constructor(message: string, public status = 0, public retryAt: number | null = null) { super(message); }
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function actor(value: unknown): Actor | null {
  if (value === null) return null;
  if (!object(value) || typeof value.login !== 'string' || typeof value.type !== 'string') throw new ApiError('GitHub returned incomplete user data.');
  return { login: value.login, type: value.type };
}
function details(value: unknown): PrDetails {
  if (!object(value) || !['open', 'closed'].includes(value.state) || typeof value.merged !== 'boolean' || typeof value.draft !== 'boolean' || !(value.closed_at === null || typeof value.closed_at === 'string') || !Array.isArray(value.labels) || value.labels.some((l: unknown) => !object(l) || typeof l.name !== 'string')) throw new ApiError('GitHub returned incomplete pull request data.');
  return { state: value.state, merged: value.merged, draft: value.draft, closed_at: value.closed_at, user: actor(value.user), labels: value.labels.map((l: { name: string }) => ({ name: l.name })), title: typeof value.title === 'string' ? value.title : '' };
}
function collection(value: unknown, review: boolean): (Comment | Review)[] {
  if (!Array.isArray(value)) throw new ApiError('GitHub returned an incomplete comment collection.');
  return value.map(v => {
    if (!object(v)) throw new ApiError('GitHub returned incomplete feedback.');
    const user = actor(v.user);
    if (!review) return { user };
    if (!Number.isSafeInteger(v.id) || typeof v.state !== 'string' || !(v.submitted_at === null || typeof v.submitted_at === 'string')) throw new ApiError('GitHub returned incomplete review data.');
    return { user, id: v.id, state: v.state, submitted_at: v.submitted_at };
  });
}

export class GitHubClient {
  private scopeReady: Promise<void>;
  retryAt: number | null = null;
  constructor(private token: string, public cache: RequestCache, private fetcher: typeof fetch = (...args) => fetch(...args), private now: () => number = Date.now) {
    this.scopeReady = crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(buffer => {
      const scope = Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
      if (cache.scope !== scope) { cache.scope = scope; cache.entries = {}; }
    });
  }

  async checkToken(): Promise<string> {
    const entry = await this.get('https://api.github.com/user', value => {
      if (!object(value) || typeof value.login !== 'string') throw new ApiError('GitHub did not recognize this account.');
      return value.login;
    }, true);
    return entry.data as string;
  }

  async details(ref: PrRef, fresh = false): Promise<PrDetails> {
    return (await this.get(this.path(ref), details, fresh)).data as PrDetails;
  }

  async snapshot(ref: PrRef, checkPermissions = false): Promise<Snapshot> {
    const pr = await this.details(ref);
    // Closed and merged PRs need no feedback queries, including in repositories
    // where the credential can read PR details but not conversation comments.
    if (pr.state === 'closed' && !checkPermissions) return { details: pr, comments: [], reviewComments: [], reviews: [] };
    const base = this.path(ref);
    const comments = await this.list(base.replace('/pulls/', '/issues/') + '/comments', false) as Comment[];
    const reviewComments = await this.list(base + '/comments', false) as Comment[];
    const reviews = await this.list(base + '/reviews', true) as Review[];
    return { details: pr, comments, reviewComments, reviews };
  }

  trimCache(): void {
    const entries = Object.entries(this.cache.entries).filter(([, entry]) => this.now() - entry.usedAt < 24 * 60 * 60 * 1000).sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, 200);
    this.cache.entries = Object.fromEntries(entries);
  }

  private path(ref: PrRef): string { return `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`; }

  private async list(base: string, review: boolean): Promise<(Comment | Review)[]> {
    let url: string | null = `${base}?per_page=100`;
    const result: (Comment | Review)[] = [], seen = new Set<string>();
    while (url) {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://api.github.com' || parsed.pathname !== new URL(base).pathname || parsed.username || parsed.password || seen.has(url) || seen.size >= 1000) throw new ApiError('GitHub returned an unsafe or incomplete pagination chain.');
      seen.add(url);
      const entry = await this.get(url, value => collection(value, review));
      result.push(...entry.data as (Comment | Review)[]);
      url = entry.next;
    }
    return result;
  }

  private async get(url: string, normalize: (data: unknown) => unknown, fresh = false): Promise<Entry> {
    await this.scopeReady;
    if (!this.token) throw new ApiError('Connect a GitHub token in Settings first.');
    if (this.retryAt && this.retryAt > this.now()) throw new ApiError('GitHub requests are waiting for the retry window.', 429, this.retryAt);
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password) throw new ApiError('Refusing an unexpected API address.');
    const cached = this.cache.entries[url];
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (!fresh && cached?.etag) headers['If-None-Match'] = cached.etag;
    let response: Response;
    try { response = await this.fetcher(url, { headers, method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
    catch { this.retryAt = this.now() + 30000; throw new ApiError('GitHub could not be reached. Tabs have been left in place.', 0, this.retryAt); }
    if (response.status === 304) {
      if (fresh || !cached) throw new ApiError('GitHub returned a cache response without usable cached data.');
      cached.usedAt = this.now(); return cached;
    }
    if (!response.ok) {
      const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
      if (limited || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        const delay = retry && /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : retry ? Date.parse(retry) : 0;
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        this.retryAt = Math.max(this.now() + 60000, Number.isFinite(delay) ? delay : 0, Number.isFinite(reset) ? reset : 0);
      }
      const repository = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\//);
      const message = response.status === 401 ? 'Your GitHub token is invalid or expired. Update it in Settings.' : limited ? 'GitHub rate limit reached. MergeLane will retry automatically.' : [403, 404].includes(response.status) && repository ? repositoryAccessError(decodeURIComponent(repository[1]), decodeURIComponent(repository[2])) : response.status === 403 ? 'GitHub denied access. Check token permissions and organization policy.' : response.status === 404 ? 'The requested GitHub resource is unavailable.' : 'GitHub is temporarily unavailable. Tabs have been left in place.';
      throw new ApiError(message, response.status, this.retryAt);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new ApiError('GitHub returned unreadable data. Tabs have been left in place.'); }
    const data = normalize(raw);
    const link = response.headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    const entry = { data, etag: response.headers.get('etag'), next, usedAt: this.now() };
    this.cache.entries[url] = entry;
    return entry;
  }
}
