import './popup.css';
import type { PublicState } from '../storage';
import { button, el, icon, relativeTime, send, showError } from './dom';

const root = document.querySelector<HTMLElement>('#popup')!;
let state: PublicState, busy = false;
let view: 'prs' | 'recent' | 'kept' = 'prs';
const prName = (key: string) => key.replace(/\/(\d+)$/, ' #$1');
function renderNavigation(): void {
  const navigation = el('div', 'viewnav'); navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', 'PR views');
  for (const [value, name, label] of [['prs', 'PRs', 'Show tracked PRs'], ['recent', `Recently closed (${state.cleanup.recent.length})`, 'Show recently closed PRs'], ['kept', `Kept open (${state.cleanup.kept.length})`, 'Show kept-open PRs']] as const) {
    const tab = button(name, view === value ? 'selected' : '', () => { view = value; render(); root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.focus(); }, label);
    tab.setAttribute('aria-pressed', String(view === value)); navigation.append(tab);
  }
  root.append(navigation);
}
function renderCleanup(): void {
  if (view === 'prs') return;
  if (view === 'kept') {
    const section = el('section', 'prsection'); section.append(el('h2', '', 'Kept open'), el('p', 'helper', 'Protected from automatic closure until you resume cleanup. Grouping still applies.'));
    if (!state.cleanup.kept.length) section.append(el('p', 'helper', 'No protected PRs. Choose Keep open beside a tracked PR, or reopen one from Recently closed.'));
    for (const pr of state.cleanup.kept) {
      const row = el('div', 'prrow'); row.append(el('strong', '', prName(pr.key)), el('p', 'helper', pr.title), button('Resume cleanup', 'textbutton', () => { void action('resumeCleanup', { key: pr.key }); }, `Resume cleanup for ${pr.key}`)); section.append(row);
    }
    section.append(el('p', 'helper', 'Resuming makes completed PRs eligible to close on the next check.')); root.append(section); return;
  }
  const section = el('section', 'prsection'); section.append(el('h2', '', 'Recently closed'));
  if (!state.cleanup.recent.length) section.append(el('p', 'helper', 'PRs closed automatically by MergeLane will appear here.'));
  for (const pr of state.cleanup.recent) {
    const row = el('div', 'prrow'); row.append(el('strong', '', prName(pr.key)), el('p', 'helper', pr.title), el('p', 'helper', `${pr.reason === 'merged' ? 'Merged' : 'Closed for more than an hour'} · ${new Date(pr.closedAt).toLocaleString()}`), button('Reopen and keep open', 'outline', () => { void action('reopenClosed', { key: pr.key }); }, `Reopen and keep open ${pr.key}`)); section.append(row);
  }
  if (state.cleanup.recent.length) section.append(button('Clear history', 'textbutton', () => { void action('clearRecent'); }));
  root.append(section);
}
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
    const setup = el('section', 'summary'); setup.append(el('h1', '', 'Connect GitHub'), el('p', '', 'Add a read-only token, choose your lanes, then enable automatic organization.')); root.append(setup, button('Open settings', 'primary', () => { void chrome.runtime.openOptionsPage(); })); renderNavigation(); renderCleanup(); return;
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
  renderNavigation();
  if (view === 'prs') {
  const tracked = el('section', 'prsection'); tracked.append(el('h2', '', 'Why these lanes?'), el('p', 'helper', 'Results from the most recent PR checks.'));
  const openKeys = new Set(state.openPrs.map(pr => pr.key)), kept = new Set(state.cleanup.kept.map(pr => pr.key));
  const prs = state.status.prs.filter(pr => openKeys.has(pr.key));
  if (!prs.length) tracked.append(el('p', 'helper', 'Open a PR and enable MergeLane to see its matching rule.'));
  for (const pr of prs) {
    const row = el('div', 'prrow'); row.dataset.pr = pr.key;
    const title = el('a', '', prName(pr.key)); title.href = pr.url; title.target = '_blank'; title.rel = 'noreferrer noopener';
    const category = state.settings.categories.find(c => c.id === pr.categoryId);
    row.append(title, el('p', 'prtitle', pr.title), el('strong', 'prlane', category?.name ?? 'Waiting for a fresh check'), el('p', 'helper', pr.explanation), el('p', 'helper', relativeTime(pr.checkedAt)));
    if (kept.has(pr.key)) row.append(el('span', 'protected', 'Kept open'));
    else row.append(button('Keep open', 'textbutton', () => { void action('keepOpen', { key: pr.key }); }, `Keep open ${pr.key}`));
    tracked.append(row);
  }
    root.append(tracked);
  }
  renderCleanup();
  const footer = el('footer', 'footer'); footer.append(el('span', '', 'Checks about once a minute'), button('Settings', 'textbutton', () => { void chrome.runtime.openOptionsPage(); })); root.append(footer);
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.status || changes.settings || changes.cleanup) && !busy) void action('getState'); });
void action('getState');
