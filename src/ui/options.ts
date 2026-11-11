import './options.css';
import { COLORS, type Category, type ConditionKind } from '../core/model';
import { defaultSettings, validateSettings } from '../core/settings';
import type { PublicState } from '../storage';
import { tokenCreationUrl } from '../github/connection';
import { button, el, icon, relativeTime, send, showError } from './dom';

const root = document.querySelector<HTMLElement>('#app')!;
const toastBox = document.querySelector<HTMLElement>('#toast')!;
let state: PublicState;
let draft = defaultSettings();
let selected = 'merging';
let dirty = false, busy = false;
let connectionOwner: string | undefined;
let connectionMessage = '';
let connectionFailed = false;
let toastTimer: ReturnType<typeof setTimeout>;
const kinds: Record<ConditionKind, string> = { label: 'Has label', feedback: 'Has human feedback', approval: 'Has active human approval', changes: 'Has changes requested', draft: 'Is a draft' };

function toast(text: string, error = false): void {
  clearTimeout(toastTimer); toastBox.textContent = text; toastBox.hidden = false; toastBox.classList.toggle('error', error);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, error ? 12000 : 5000);
}
function changed(): void { dirty = true; updateFooter(); }
function edit(action: () => void): void { action(); changed(); render(); }
function swap<T>(array: T[], i: number, j: number): void { [array[i], array[j]] = [array[j], array[i]]; }
function laneIcon(c: Category): string { return c.fallback ? 'progress' : c.id === 'merging' ? 'merge' : c.conditions[0]?.kind === 'approval' ? 'approval' : c.conditions[0]?.kind === 'feedback' ? 'feedback' : 'label'; }
function color(element: HTMLElement, lane: Category): void { element.style.setProperty('--lane', `var(--${lane.color})`); }
function field(label: string, id: string, input: HTMLElement): HTMLElement {
  const f = el('div', 'field'), l = el('label', 'fieldlabel', label); l.htmlFor = id; input.id = id; f.append(l, input); return f;
}

async function save(): Promise<void> {
  if (busy) return;
  try {
    const checked = validateSettings(draft);
    busy = true; root.inert = true; root.setAttribute('aria-busy', 'true');
    state = await send('saveSettings', { settings: checked });
    draft = structuredClone(state.settings); dirty = false; render();
    toast('Settings saved.');
  } catch (error) { toast(showError(error), true); }
  finally { busy = false; root.inert = false; root.removeAttribute('aria-busy'); }
}
async function operate(type: string, data: Record<string, unknown>, message: string): Promise<void> {
  if (busy) return;
  busy = true; root.inert = true; root.setAttribute('aria-busy', 'true');
  if (type === 'setToken' || type === 'checkConnection') {
    const result = document.getElementById('connectionResult');
    if (result) { result.textContent = 'Checking your GitHub account and PR access…'; result.className = 'helper'; result.hidden = false; }
  }
  try {
    state = await send(type, data);
    // Keep unfinished category edits, but take operational state from the
    // worker. Pausing/disconnecting never validates or saves those edits.
    if (!dirty) draft = structuredClone(state.settings);
    draft.enabled = state.settings.enabled;
    if (state.connectionCheck) {
      const check = state.connectionCheck;
      connectionMessage = check.checked ? `Access verified for ${check.checked} PR${check.checked === 1 ? '' : 's'}${check.owner ? ` under ${check.owner}` : ''}. Signed in as ${check.login}.` : `Account verified as ${check.login}. Repository access has not been tested. Open a PR${check.owner ? ` under ${check.owner}` : ''}, then click Check access.`;
      connectionFailed = false;
      message = connectionMessage;
    } else if (type === 'disconnect' || type === 'removeConnection') { connectionMessage = ''; connectionFailed = false; }
    render(); toast(message);
  } catch (error) {
    const message = showError(error);
    if (type === 'setToken' || type === 'checkConnection') {
      connectionMessage = message; connectionFailed = true;
      const result = document.getElementById('connectionResult');
      if (result) { result.textContent = message; result.className = 'notice error'; result.hidden = false; }
    }
    toast(message, true);
  }
  finally { busy = false; root.inert = false; root.removeAttribute('aria-busy'); }
}
async function toggleEnabled(): Promise<void> {
  if (!state.hasToken) { document.getElementById('connection')?.scrollIntoView({ behavior: 'smooth' }); document.getElementById('token')?.focus(); return; }
  const enabled = !state.settings.enabled;
  await operate('setEnabled', { enabled }, enabled ? 'Settings saved. MergeLane is enabled.' : 'MergeLane is paused.');
}

function renderViews(): void {
  const tabs = document.getElementById('tabstrip'), list = document.getElementById('lanes');
  if (!tabs || !list) return;
  tabs.replaceChildren(); list.replaceChildren();
  document.getElementById('laneNumber')!.textContent = String(draft.categories.length).padStart(2, '0');
  for (const lane of draft.categories) {
    const count = state.status.counts[lane.id] ?? 0;
    if (lane.enabled) {
      const group = el('div', 'tabgroup'); color(group, lane);
      group.append(el('span', 'tabchip', lane.name || 'Untitled'), el('span', 'tabcount', String(count)), el('p', 'minitab', count ? `${count} tracked tab${count === 1 ? '' : 's'}` : 'No tabs in this lane'));
      tabs.append(group);
    }
    const row = button('', `lane${selected === lane.id ? ' selected' : ''}${!lane.enabled ? ' disabled' : ''}`, () => { selected = lane.id; renderViews(); renderEditor(); }, `Edit ${lane.name}`);
    color(row, lane); row.setAttribute('aria-pressed', String(selected === lane.id));
    const symbol = el('span', 'laneicon'); symbol.append(icon(laneIcon(lane), 17));
    const text = el('span', 'lanetext');
    text.append(el('strong', '', lane.name || 'Untitled'), el('small', '', lane.fallback ? 'Fallback lane' : !lane.enabled ? 'Disabled' : lane.conditions.length > 1 ? `${lane.mode === 'all' ? 'All' : 'Any'} of ${lane.conditions.length} conditions` : kinds[lane.conditions[0]?.kind] || 'Custom rule'));
    row.append(symbol, text, el('span', 'lanecount', String(count))); list.append(row);
  }
  const lastCheck = document.getElementById('lastCheck');
  if (lastCheck) lastCheck.textContent = state.status.running ? 'Checking GitHub…' : relativeTime(state.status.checkedAt);
  const errors = document.getElementById('errors')!; errors.replaceChildren();
  for (const error of state.status.errors.slice(0, 5)) {
    const item = el('div', 'notice error erroritem');
    if (error.pr) item.append(el('strong', '', error.pr));
    item.append(el('span', '', error.message)); errors.append(item);
  }
  if (state.status.retryAt && state.status.retryAt > Date.now()) errors.append(el('p', 'helper', `Limited connections retry after ${new Date(state.status.retryAt).toLocaleTimeString()}. Other connections continue checking.`));
  updateFooter();
}

function stepper(label: string, help: string, index: number, total: number, move: (delta: number) => void): HTMLElement {
  const row = el('div', 'settingrow'), text = el('div'); text.append(el('span', 'fieldlabel', label), el('p', '', help));
  const controls = el('div', 'stepper');
  const prev = button('←', '', () => move(-1), `Move ${label.toLowerCase()} earlier`); prev.disabled = index === 0;
  const next = button('→', '', () => move(1), `Move ${label.toLowerCase()} later`); next.disabled = index === total - 1;
  controls.append(prev, el('span', '', `${index + 1} / ${total}`), next); row.append(text, controls); return row;
}

function renderEditor(): void {
  const lane = draft.categories.find(c => c.id === selected) ?? draft.categories[0]; selected = lane.id;
  const editor = document.getElementById('editor')!; editor.replaceChildren();
  const heading = el('div', 'editorhead'), symbol = el('div', 'editicon'); color(symbol, lane); symbol.append(icon(laneIcon(lane), 23));
  const title = el('div'), titleText = el('h2', '', lane.name || 'Untitled'); title.append(titleText, el('p', '', lane.fallback ? 'Default category' : 'Category settings')); heading.append(symbol, title);
  if (!lane.fallback) {
    const label = el('label', 'enabled'); const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = lane.enabled;
    enabled.onchange = () => edit(() => { lane.enabled = enabled.checked; }); label.append(enabled, 'Enabled'); heading.append(label);
  }
  editor.append(heading);
  const name = el('input', 'input'); name.value = lane.name; name.maxLength = 40;
  name.oninput = () => { lane.name = name.value; titleText.textContent = name.value || 'Untitled'; changed(); renderViews(); };
  editor.append(field('Name', 'laneName', name));
  const appearance = el('div', 'appearance');
  for (const c of COLORS) {
    const swatch = button('', `swatch${lane.color === c ? ' selected' : ''}`, () => edit(() => { lane.color = c; }), `Use ${c} group color`);
    swatch.title = c; swatch.style.setProperty('--swatch', `var(--${c})`); swatch.setAttribute('aria-pressed', String(lane.color === c)); swatch.append(el('i')); appearance.append(swatch);
  }
  appearance.append(el('span', 'colorname', lane.color[0].toUpperCase() + lane.color.slice(1)));
  const appearanceField = el('div', 'field'); appearanceField.append(el('span', 'fieldlabel', 'Group color'), appearance); editor.append(appearanceField);
  if (lane.fallback) editor.append(el('p', 'fallbacknote', 'PRs land here when no other category matches. This fallback always stays enabled.'));
  else {
    const ruleHead = el('div', 'rulehead'); ruleHead.append(el('span', 'fieldlabel', 'Move tabs here when'));
    const mode = el('select', 'tinyselect'); mode.setAttribute('aria-label', 'Condition matching mode');
    for (const [value, label] of [['all', 'All conditions match'], ['any', 'Any condition matches']]) { const option = el('option', '', label); option.value = value; option.selected = lane.mode === value; mode.append(option); }
    mode.onchange = () => edit(() => { lane.mode = mode.value as 'all' | 'any'; }); ruleHead.append(mode); editor.append(ruleHead);
    lane.conditions.forEach((condition, index) => {
      const rule = el('div', 'rule'), line = el('div', 'ruleline'); line.append(icon(condition.kind === 'label' ? 'label' : 'feedback', 15));
      const kind = el('select', 'ruleselect'); kind.setAttribute('aria-label', `Condition ${index + 1} type`);
      for (const [value, label] of Object.entries(kinds)) { const option = el('option', '', label); option.value = value; option.selected = condition.kind === value; kind.append(option); }
      kind.onchange = () => edit(() => { condition.kind = kind.value as ConditionKind; if (condition.kind === 'label') condition.value ??= ''; else delete condition.value; });
      line.append(kind);
      if (lane.conditions.length > 1) line.append(button('×', 'delete', () => edit(() => { lane.conditions.splice(index, 1); }), `Remove condition ${index + 1}`));
      rule.append(line);
      if (condition.kind === 'label') {
        const input = el('input', 'input labelvalue'); input.value = condition.value ?? ''; input.placeholder = 'Enter a label'; input.maxLength = 100; input.setAttribute('aria-label', `Condition ${index + 1} label name`);
        input.oninput = () => { condition.value = input.value; changed(); }; rule.append(input);
      } else if (condition.kind === 'feedback') rule.append(el('p', 'rulehelp', 'Comments and submitted reviews from another human. Authors and bots are ignored.'));
      else if (condition.kind === 'approval') rule.append(el('p', 'rulehelp', 'An active human approval, with no outstanding changes requested.'));
      const negateLabel = el('label', 'negate'), negate = el('input'); negate.type = 'checkbox'; negate.checked = condition.negate;
      negate.onchange = () => { condition.negate = negate.checked; changed(); }; negateLabel.append(negate, 'Match when this condition is absent'); rule.append(negateLabel); editor.append(rule);
    });
    const add = button('Add condition', 'addcondition', () => { if (lane.conditions.length >= 20) return toast('A category can have up to 20 conditions.', true); edit(() => { lane.conditions.push({ kind: 'label', value: '', negate: false }); }); }); add.prepend(icon('plus', 13)); editor.append(add);
  }
  const order = el('div', 'orderrows'), index = draft.categories.indexOf(lane);
  order.append(stepper('Tab-strip position', 'Left to right in Chrome', index, draft.categories.length, delta => edit(() => swap(draft.categories, index, index + delta))));
  if (!lane.fallback) { const rank = draft.priority.indexOf(lane.id); order.append(stepper('Rule priority', 'First matching category wins', rank, draft.priority.length, delta => edit(() => swap(draft.priority, rank, rank + delta)))); }
  editor.append(order);
  const foot = el('div', 'editorfoot');
  if (!lane.fallback) foot.append(button('Remove lane', 'remove', () => edit(() => { draft.categories = draft.categories.filter(c => c.id !== lane.id); draft.priority = draft.priority.filter(id => id !== lane.id); selected = draft.categories[0].id; })));
  else foot.append(el('span', 'helper', 'Always available'));
  foot.append(button('Save changes', 'primary', () => { void save(); })); editor.append(foot);
}

function renderConnection(): HTMLElement {
  const section = el('section', 'connection'); section.id = 'connection';
  section.append(el('h2', '', 'GitHub connections'), el('p', 'helper', 'Connect each organization or account whose PRs you track. Tokens stay in this Chrome profile.'));
  const savedConnections = el('div', 'savedconnections');
  for (const saved of [...state.settings.connections, ...(state.hasLegacyToken ? [{ owner: '', token: '' }] : [])]) {
    const row = el('div', 'settingrow'), description = el('div');
    description.append(el('span', 'fieldlabel', saved.owner || 'Existing token · default connection'), el('p', '', saved.owner ? 'Used automatically for this owner’s PRs.' : 'Preserved from earlier setup. Used when an owner has no separate connection.'));
    const actions = el('div', 'actions');
    actions.append(button('Check', 'outline', () => { void operate('checkConnection', { owner: saved.owner }, ''); }, `Check ${saved.owner || 'default'} connection`), button('Remove', 'textbutton', () => { void operate('removeConnection', { owner: saved.owner }, 'Connection removed.'); }, `Remove ${saved.owner || 'default'} connection`));
    row.append(description, actions); savedConnections.append(row);
  }
  section.append(savedConnections);
  const grid = el('div', 'connectiongrid'), credentials = el('div'), ignored = el('div');
  const owners = [...new Map([...state.openPrs, ...state.settings.connections].map(ref => [ref.owner.toLowerCase(), ref.owner])).values()];
  connectionOwner ??= owners[0] ?? '';
  const owner = el('input', 'input'); owner.value = connectionOwner; owner.placeholder = 'Organization or account name'; owner.maxLength = 39; owner.autocomplete = 'off'; owner.spellcheck = false;
  const suggestions = el('datalist'); suggestions.id = 'openPrOwners'; owner.setAttribute('list', suggestions.id);
  for (const name of owners) { const option = el('option'); option.value = name; suggestions.append(option); }
  credentials.append(field('1. Resource owner', 'resourceOwner', owner), suggestions);
  credentials.append(el('p', 'helper', 'Use the organization that owns your repository. “All repositories” only covers this owner, not organizations you belong to.'));
  const help = el('p', 'helper'), link = el('a'); link.target = '_blank'; link.rel = 'noreferrer noopener';
  const updateLink = () => { connectionOwner = owner.value.trim(); link.href = tokenCreationUrl(connectionOwner); link.textContent = connectionOwner ? `Create token for ${connectionOwner}` : 'Create a read-only token'; };
  owner.oninput = updateLink; updateLink();
  link.onclick = event => {
    event.preventDefault();
    void operate('beginImport', { owner: owner.value.trim() }, 'GitHub setup opened. Generate the token, then click Import into MergeLane on that page.');
  };
  help.append(link, '. Select repositories and generate the token on GitHub, then click Import into MergeLane. Read permissions are prefilled.'); credentials.append(help);
  credentials.append(el('p', 'helper', 'Or paste a token below. Adding another owner keeps your existing connections. Organization approval may still be required.'));
  const token = el('input', 'input'); token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false; token.placeholder = state.hasToken ? 'Paste a replacement token' : 'Paste your GitHub token'; token.maxLength = 1000;
  credentials.append(field('Personal access token', 'token', token));
  const actions = el('div', 'actions'); actions.append(button(state.hasToken ? 'Update token' : 'Connect GitHub', 'primary', () => { if (!token.value.trim()) return toast('Paste a GitHub token first.', true); void operate('setToken', { token: token.value.trim(), owner: owner.value.trim() }, ''); }));
  if (state.hasToken) actions.append(button('Check access', 'outline', () => { void operate('checkConnection', { owner: owner.value.trim() }, ''); }), button('Disconnect', 'textbutton', () => { void operate('disconnect', {}, 'Disconnected. MergeLane is paused.'); })); credentials.append(actions);
  const result = el('p', connectionFailed ? 'notice error' : 'helper', connectionMessage); result.id = 'connectionResult'; result.setAttribute('role', 'status'); result.hidden = !connectionMessage; credentials.append(result);
  const accounts = el('textarea', 'input'); accounts.value = draft.ignoredLogins.join('\n'); accounts.placeholder = 'automation-account\nreview-helper'; accounts.spellcheck = false;
  accounts.oninput = () => { draft.ignoredLogins = accounts.value.split(/[\s,]+/).filter(Boolean); changed(); };
  ignored.append(field('Additional accounts to ignore', 'ignoredLogins', accounts), el('p', 'helper', 'GitHub bots and PR authors are already ignored. Add automation that uses ordinary user accounts, one login per line.'));
  ignored.append(button('Save preferences', 'textbutton', () => { void save(); })); grid.append(credentials, ignored); section.append(grid);
  const enabling = el('div', 'settingrow'); enabling.style.marginTop = '24px';
  const explanation = el('div'); explanation.append(el('span', 'fieldlabel', 'Automatic organization and cleanup'), el('p', '', 'Enabling also closes merged PR tabs and PRs closed for more than one hour.'));
  const enable = button(draft.enabled ? 'Pause MergeLane' : 'Enable MergeLane', draft.enabled ? 'outline' : 'primary', () => { void toggleEnabled(); }); enable.disabled = !state.hasToken;
  enabling.append(explanation, enable); section.append(enabling); return section;
}

function updateFooter(): void {
  const foot = document.getElementById('saveState');
  if (foot) foot.textContent = dirty ? 'Unsaved changes' : state?.settings.enabled ? 'Automatic checks about once a minute' : 'Paused · your tabs are left in place';
}

function render(): void {
  root.replaceChildren();
  const top = el('header', 'topbar'), brand = el('div', 'wordmark'), mark = el('span', 'mark'); mark.append(icon('merge', 21)); brand.append(mark, 'MergeLane');
  const right = el('div', 'topright'), status = el('span', `pill${state.settings.enabled ? ' active' : ''}`); status.append(el('i', 'dot'), state.settings.enabled ? 'Active' : 'Paused');
  right.append(status, button(!state.hasToken ? 'Connect GitHub' : draft.enabled ? 'Pause' : 'Enable', 'textbutton', () => { void toggleEnabled(); })); top.append(brand, right); root.append(top);
  const intro = el('section', 'intro'), title = el('div'); title.append(el('div', 'eyebrow', 'Preferences / Organization'), el('h1', '', 'Workflow'), el('p', '', 'Give every pull request a place in your browser.'));
  intro.append(title, button('Restore defaults', 'textbutton', () => edit(() => { const defaults = defaultSettings(); draft.categories = defaults.categories; draft.priority = defaults.priority; selected = 'merging'; }))); root.append(intro);
  const errors = el('div', 'errors'); errors.id = 'errors'; errors.setAttribute('role', 'status'); root.append(errors);
  const showConnectionFirst = !state.hasToken || state.status.errors.length > 0;
  if (showConnectionFirst) root.append(renderConnection());
  const browser = el('section', 'browser'), browserLabel = el('div', 'browserlabel'), browserTitle = el('span'); browserTitle.append(icon('window', 15), 'Chrome tab groups');
  const time = el('span'); time.id = 'lastCheck'; browserLabel.append(browserTitle, time); const strip = el('div', 'tabstrip'); strip.id = 'tabstrip'; browser.append(browserLabel, strip); root.append(browser);
  const workspace = el('section', 'workspace'), sidebar = el('aside', 'sidebar'), sidehead = el('div', 'sidehead'), number = el('span', 'num'); number.id = 'laneNumber'; sidehead.append(el('span', 'sectiontitle', 'Your lanes'), number);
  const lanes = el('div', 'lanes'); lanes.id = 'lanes'; const add = button('Add a lane', 'addlane', () => {
    if (draft.categories.length >= 50) return toast('You can have up to 50 categories.', true);
    edit(() => { const id = crypto.randomUUID(); let name = 'New lane', count = 2; while (draft.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) name = `New lane ${count++}`; draft.categories.push({ id, name, color: 'orange', enabled: true, fallback: false, mode: 'all', conditions: [{ kind: 'label', value: 'needs-attention', negate: false }] }); draft.priority.unshift(id); selected = id; });
  }); add.prepend(icon('plus', 14));
  const sidefoot = el('div', 'sidefoot'); sidefoot.append(el('strong', '', 'Order is yours.'), 'Choose a lane to edit its name, color, and matching rules.'); sidebar.append(sidehead, lanes, add, sidefoot);
  const editor = el('div', 'editor'); editor.id = 'editor'; workspace.append(sidebar, editor); root.append(workspace);
  const cleanup = el('section', 'cleanup'), copy = el('div'); copy.append(el('h3', '', 'Automatic tab cleanup'), el('p', '', 'Merged tabs close on detection. Closed PRs get a one-hour grace period. Reopening cancels cleanup; closing again starts a fresh hour. GitHub is checked again before a tab closes.')); cleanup.append(icon('archive', 20), copy); root.append(cleanup);
  if (!showConnectionFirst) root.append(renderConnection());
  const footer = el('footer', 'footer'), saved = el('span'); saved.id = 'saveState'; footer.append(saved, el('span', '', `MergeLane ${chrome.runtime.getManifest().version} · Stored on this device`)); root.append(footer);
  renderViews(); renderEditor(); updateFooter();
}

async function start(): Promise<void> {
  try { state = await send('getState'); draft = structuredClone(state.settings); render(); }
  catch (error) { root.replaceChildren(el('p', 'notice error', showError(error)), button('Try again', 'textbutton', () => { void start(); })); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !state) return;
  if (changes.status) { state.status = changes.status.newValue as PublicState['status']; renderViews(); }
  if (changes.settings && !busy) {
    if (!dirty) void start();
    else void send('getState').then(latest => {
      if (busy) return;
      state = latest; draft.enabled = latest.settings.enabled; render();
    }).catch(error => toast(showError(error), true));
  }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
void start();
