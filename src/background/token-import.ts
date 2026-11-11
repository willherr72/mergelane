import { IMPORT_LIFETIME, importAllowed, type ImportSession } from '../core/token-import';
import { tokenCreationUrl } from '../github/connection';

// Call mutations from the worker's shared command queue so a disconnect or
// second import cannot race a successful credential verification.
async function sessions(): Promise<ImportSession[]> {
  const { tokenImports } = await chrome.storage.session.get<{ tokenImports?: ImportSession[] }>('tokenImports');
  return (tokenImports ?? []).filter(s => s.expiresAt > Date.now());
}
export async function beginImport(owner: string): Promise<void> {
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(owner)) throw new Error('Enter the organization or account that owns your repositories.');
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined || tab.incognito) throw new Error('Open MergeLane in a normal Chrome window.');
  const session = { tabId: tab.id, owner, expiresAt: Date.now() + IMPORT_LIFETIME };
  await chrome.storage.session.set({ tokenImports: [...(await sessions()).slice(-9), session] });
  try { await chrome.tabs.update(tab.id, { url: tokenCreationUrl(owner) }); }
  catch (error) { await cancelImports(s => s.tabId === tab.id); throw error; }
}
export async function importSession(sender: chrome.runtime.MessageSender): Promise<ImportSession | undefined> {
  if (sender.tab?.id === undefined) return;
  const session = (await sessions()).find(s => s.tabId === sender.tab!.id);
  if (!session) return;
  const live = await chrome.tabs.get(session.tabId).catch(() => undefined);
  return live && importAllowed(session, sender, live, Date.now()) ? session : undefined;
}
export async function requireImportSession(sender: chrome.runtime.MessageSender): Promise<ImportSession> {
  const session = await importSession(sender);
  if (!session) throw new Error('This import session has ended. Start Connect owner again from MergeLane Settings.');
  return session;
}
export async function cancelImports(matches: (session: ImportSession) => boolean): Promise<void> {
  await chrome.storage.session.set({ tokenImports: (await sessions()).filter(s => !matches(s)) });
}
