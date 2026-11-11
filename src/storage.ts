import { defaultSettings, validateSettings } from './core/settings';
import { emptyOwnership, emptyStatus, hasCredentials, type Ownership, type RunStatus, type Settings } from './core/model';
import type { RequestCache } from './github/client';
import { parsePrUrl } from './core/url';
import type { PrRef } from './core/model';
import type { ConnectionCheck } from './github/connection';
import type { OwnerCache } from './github/owners';
import { emptyCleanup, type CleanupState } from './core/cleanup';
import type { ConnectionHealth } from './core/health';

export async function readCleanup(): Promise<CleanupState> {
  const { cleanup } = await chrome.storage.local.get<{ cleanup?: CleanupState }>('cleanup');
  return cleanup ?? emptyCleanup();
}
export async function readHealth(): Promise<ConnectionHealth[]> {
  const { connectionHealth } = await chrome.storage.local.get<{ connectionHealth?: ConnectionHealth[] }>('connectionHealth');
  return connectionHealth ?? [];
}

export async function initializeStorage(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: defaultSettings() });
}
export async function readSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return validateSettings(settings ?? defaultSettings());
}
export async function readRunState(): Promise<{ ownership: Ownership; status: RunStatus; caches: OwnerCache[] }> {
  const [local, session] = await Promise.all([chrome.storage.local.get<{ status?: RunStatus; cache?: RequestCache; connectionCaches?: OwnerCache[] }>(['status', 'cache', 'connectionCaches']), chrome.storage.session.get<{ ownership?: Ownership }>('ownership')]);
  return { ownership: session.ownership ?? emptyOwnership(), status: { ...emptyStatus(), ...local.status }, caches: local.connectionCaches ?? (local.cache?.scope && local.cache?.entries ? [{ owner: '', cache: local.cache, retryAt: local.status?.retryAt ?? null }] : []) };
}
export async function openPullRequests(): Promise<PrRef[]> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const refs = windows.filter(window => !window.incognito).flatMap(window => (window.tabs ?? []).filter(tab => !tab.incognito).map(tab => parsePrUrl(tab.pendingUrl || tab.url || '')).filter((ref): ref is PrRef => !!ref));
  return [...new Map(refs.map(ref => [ref.key, ref])).values()];
}
export interface PublicState { settings: Settings; hasToken: boolean; hasLegacyToken: boolean; status: RunStatus; openPrs: PrRef[]; connectionCheck?: ConnectionCheck; cleanup: CleanupState; connectionHealth: ConnectionHealth[] }
export async function publicState(): Promise<PublicState> {
  const [settings, { status }, openPrs, cleanup, connectionHealth] = await Promise.all([readSettings(), readRunState(), openPullRequests(), readCleanup(), readHealth()]);
  return { settings: { ...settings, token: '', connections: settings.connections.map(c => ({ owner: c.owner, token: '' })) }, hasToken: hasCredentials(settings), hasLegacyToken: !!settings.token, status, openPrs, cleanup, connectionHealth };
}
