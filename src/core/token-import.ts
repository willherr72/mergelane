export interface ImportSession { tabId: number; owner: string; expiresAt: number }
export const IMPORT_LIFETIME = 30 * 60 * 1000;

export function tokenSettingsUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return url.origin === 'https://github.com' && !url.username && !url.password && /^\/settings\/personal-access-tokens(?:\/[^?#]*)?$/.test(url.pathname);
  } catch { return false; }
}

export function importAllowed(session: ImportSession | undefined, sender: chrome.runtime.MessageSender, live: chrome.tabs.Tab, now: number): boolean {
  return !!session && session.expiresAt > now && sender.frameId === 0 && sender.tab?.id === session.tabId && live.id === session.tabId && !sender.tab.incognito && !live.incognito && tokenSettingsUrl(sender.url) && tokenSettingsUrl(live.url) && (!live.pendingUrl || live.pendingUrl === live.url) && live.status !== 'loading';
}

export function selectGeneratedToken(values: string[]): string {
  const tokens = [...new Set(values.map(v => v.trim()).filter(v => /^github_pat_[a-zA-Z0-9_]{30,245}$/.test(v)))];
  if (tokens.length > 1) throw new Error('MergeLane found more than one token. Use manual paste in MergeLane Settings.');
  if (!tokens.length) throw new Error('MergeLane could not find a newly generated token. Generate it on GitHub first, or use manual paste in MergeLane Settings.');
  return tokens[0];
}
