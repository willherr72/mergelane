import './popup.css';
import type { PublicState } from '../storage';
import { button, el, icon, relativeTime, send, showError } from './dom';

const root = document.querySelector<HTMLElement>('#popup')!;
let state: PublicState, busy = false;
async function action(type: string, data: Record<string, unknown> = {}): Promise<void> {
  if (busy) return;
  busy = true; root.inert = true;
  try { state = await send(type, data); render(); }
  catch (error) { root.prepend(el('p', 'notice error', showError(error))); }
  finally { busy = false; root.inert = false; }
}
function render(): void {
  root.replaceChildren();
  const head = el('header', 'head'), brand = el('div', 'wordmark'), mark = el('span', 'mark'); mark.append(icon('merge', 20)); brand.append(mark, 'MergeLane');
  const status = el('span', `pill${state.settings.enabled ? ' active' : ''}`); status.append(el('i', 'dot'), state.settings.enabled ? 'Active' : 'Paused'); head.append(brand, status); root.append(head);
  if (!state.hasToken) {
    const setup = el('section', 'summary'); setup.append(el('h1', '', 'Connect GitHub'), el('p', '', 'Add a read-only token, choose your lanes, then enable automatic organization.')); root.append(setup, button('Open settings', 'primary', () => { void chrome.runtime.openOptionsPage(); })); return;
  }
  const summary = el('section', 'summary'); summary.append(el('h1', '', `${state.status.tracked} PR tab${state.status.tracked === 1 ? '' : 's'}`), el('p', '', state.status.running ? 'Checking GitHub…' : relativeTime(state.status.checkedAt)));
  const categories = el('div', 'categories');
  for (const c of state.settings.categories.filter(c => c.enabled)) {
    const row = el('div', 'category'); row.style.setProperty('--lane', `var(--${c.color})`); row.append(el('i'), el('strong', '', c.name), el('span', '', String(state.status.counts[c.id] ?? 0))); categories.append(row);
  }
  summary.append(categories); root.append(summary);
  if (state.status.errors.length) root.append(el('p', 'notice error', `${state.status.errors[0].message}${state.status.errors.length > 1 ? ` (${state.status.errors.length} PR checks affected.)` : ''}`));
  const actions = el('div', 'actions');
  const refresh = button('Refresh now', 'outline', () => { void action('refresh'); }); refresh.disabled = !state.settings.enabled || state.status.running;
  const toggle = button(state.settings.enabled ? 'Pause' : 'Enable MergeLane', 'primary', () => { void action('setEnabled', { enabled: !state.settings.enabled }); });
  actions.append(refresh, toggle); root.append(actions, el('p', 'cleanup-note', 'When enabled: merged tabs close on detection; closed PRs close after more than one hour.'));
  const footer = el('footer', 'footer'); footer.append(el('span', '', 'Checks about once a minute'), button('Settings', 'textbutton', () => { void chrome.runtime.openOptionsPage(); })); root.append(footer);
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.status || changes.settings) && !busy) void action('getState'); });
void action('getState');
