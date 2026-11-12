import type { PrRef, Settings } from '../core/model';
import { ApiError, emptyCache, GitHubClient, type RequestCache } from './client';

export interface OwnerCache { owner: string; cache: RequestCache; retryAt: number | null }

export class OwnerClient {
  private clients = new Map<string, GitHubClient>();
  constructor(settings: Settings, caches: OwnerCache[], fetcher?: typeof fetch, now: () => number = Date.now) {
    const entries = [...settings.connections, ...(settings.token ? [{ owner: '', token: settings.token }] : [])];
    for (const connection of entries) {
      if (!connection.token) continue;
      const key = connection.owner.toLowerCase();
      const saved = caches.find(c => c.owner === key);
      const client = new GitHubClient(connection.token, saved?.cache ?? emptyCache(), fetcher, now);
      client.retryAt = saved?.retryAt ?? null;
      this.clients.set(key, client);
    }
  }
  private forOwner(owner: string): GitHubClient {
    const client = this.clients.get(owner.toLowerCase()) ?? this.clients.get('');
    if (!client) throw new ApiError(`Connect ${owner} in MergeLane Settings to track this PR. Its tab has been left in place.`);
    return client;
  }
  async snapshot(ref: PrRef) { return this.forOwner(ref.owner).snapshot(ref); }
  async details(ref: PrRef, fresh: boolean) { return this.forOwner(ref.owner).details(ref, fresh); }
  async authoredPullRequests(owner: string) { return this.forOwner(owner).authoredPullRequests(owner); }
  exportCaches(): OwnerCache[] {
    return [...this.clients].map(([owner, client]) => { client.trimCache(); return { owner, cache: client.cache, retryAt: client.retryAt }; });
  }
}
