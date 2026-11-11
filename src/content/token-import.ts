import { selectGeneratedToken, tokenSettingsUrl } from '../core/token-import';

// No web-page message bridge. The worker authorizes this exact top-level tab.
// Token controls are read only inside the trusted-click handler below.
let panel: HTMLElement | undefined;
let mounting = false;
async function message(type: string, data: Record<string, unknown> = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error ?? 'MergeLane could not complete this import. Open its settings to try again.');
  return reply.data;
}

function readGeneratedToken(): string {
  const values: string[] = [];
  for (const element of document.querySelectorAll('input[readonly], textarea[readonly], clipboard-copy[value], [data-clipboard-text], [data-copy-text], #new-access-token, #new-oauth-token')) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) values.push(element.value);
    for (const name of ['value', 'data-clipboard-text', 'data-copy-text']) values.push(element.getAttribute(name) ?? '');
    if (element.id === 'new-access-token' || element.id === 'new-oauth-token') values.push(element.textContent ?? '');
  }
  return selectGeneratedToken(values);
}

async function mount(): Promise<void> {
  if (!tokenSettingsUrl(location.href)) { panel?.remove(); return; }
  if (mounting || panel?.isConnected || !document.body) return;
  mounting = true;
  try {
    const context = await message('importContext');
    if (!context || !tokenSettingsUrl(location.href)) return;
    panel = document.createElement('div'); panel.id = 'mergelane-token-import';
    const shadow = panel.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;right:24px;bottom:24px;width:min(370px,calc(100vw - 32px));z-index:2147483647;color-scheme:dark}*{box-sizing:border-box}.card{background:#303235;color:#e2e3e5;border:1px solid #63676c;border-radius:8px;padding:20px;box-shadow:0 6px 24px #0004;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}h2{font-size:17px;margin:0 0 8px;font-weight:600}p{font-size:13px;color:#b3b7bb;margin:0 0 14px}button{border:0;border-radius:4px;background:#81cdb5;color:#17392f;padding:10px 16px;font-family:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer}button:hover{background:#9ddcc8}button:focus-visible{outline:2px solid #e2e3e5;outline-offset:3px}button:disabled{opacity:.6;cursor:default}.error{color:#efaaaa}`;
    const card = document.createElement('section'); card.className = 'card'; card.setAttribute('aria-label', 'MergeLane token import');
    const heading = document.createElement('h2'); heading.textContent = `Connect ${context.owner} to MergeLane`;
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Generate your token on GitHub, then import it here. MergeLane reads it only when you click Import.';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Import into MergeLane';
    let importing = false;
    button.addEventListener('click', async event => {
      if (!event.isTrusted || importing) return;
      importing = true; button.disabled = true; status.className = ''; status.textContent = 'Checking your GitHub account and repository access…';
      let token = '';
      try {
        token = readGeneratedToken();
        const result = await message('importToken', { token });
        const check = result.connectionCheck;
        status.textContent = check.checked ? `Imported for ${check.owner}. Access verified for ${check.checked} PR${check.checked === 1 ? '' : 's'}.` : `Imported for ${check.owner}. Account verified; repository access is untested. Open a PR and use Check access in MergeLane Settings.`;
        button.textContent = 'Imported';
      } catch (error) {
        status.className = 'error'; status.textContent = error instanceof Error ? error.message : 'Import failed. Use manual paste in MergeLane Settings.';
        button.disabled = false; importing = false;
      } finally { token = ''; }
    });
    card.append(heading, status, button); shadow.append(style, card); document.body.append(panel);
  } catch { /* An unrelated tab, expired extension context, or unavailable worker gets no helper. */ }
  finally { mounting = false; }
}

void mount();
// GitHub uses partial navigation as well as full loads. Reattach the helper if
// the page replaces its body, but do not inspect token controls while observing.
new MutationObserver(() => { if (!panel?.isConnected || !tokenSettingsUrl(location.href)) void mount(); }).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('load', () => { void mount(); }, { once: true });
for (const delay of [500, 2000]) setTimeout(() => { void mount(); }, delay);
