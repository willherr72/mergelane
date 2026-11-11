import { COLORS, type Category, type Condition, type Settings } from './model';

export function defaultSettings(): Settings {
  const category = (id: string, name: string, color: Category['color'], conditions: Condition[], fallback = false): Category => ({ id, name, color, conditions, fallback, enabled: true, mode: 'all' });
  return { version: 1, enabled: false, token: '', connections: [], ignoredLogins: [], priority: ['merging', 'approved', 'review'], categories: [
    category('progress', 'In Progress', 'blue', [], true),
    category('review', 'In Review', 'yellow', [{ kind: 'feedback', negate: false }]),
    category('approved', 'Approved', 'green', [{ kind: 'approval', negate: false }]),
    category('merging', 'Merging', 'purple', [{ kind: 'label', value: 'mergify-queue', negate: false }]),
  ] };
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateSettings(value: unknown): Settings {
  assert(record(value) && value.version === 1, 'This settings version is not supported.');
  assert(typeof value.enabled === 'boolean' && typeof value.token === 'string' && value.token.length <= 1000, 'Invalid connection settings.');
  const owners = new Set<string>();
  const connections = value.connections ?? [];
  assert(Array.isArray(connections) && connections.length <= 50, 'Use at most 50 owner connections.');
  for (const c of connections) {
    assert(record(c) && typeof c.owner === 'string' && /^[a-z\d][a-z\d-]{0,38}$/i.test(c.owner) && !owners.has(c.owner.toLowerCase()) && typeof c.token === 'string' && c.token.length <= 1000, 'Each connection needs a unique valid owner and token.');
    owners.add(c.owner.toLowerCase());
  }
  assert(Array.isArray(value.ignoredLogins) && value.ignoredLogins.length <= 200 && value.ignoredLogins.every((v: unknown) => typeof v === 'string' && /^[\w[\]-]{1,100}$/.test(v)), 'Enter GitHub logins separated by commas or new lines.');
  assert(Array.isArray(value.categories) && value.categories.length > 0 && value.categories.length <= 50, 'Use between 1 and 50 categories.');
  const ids = new Set<string>(), names = new Set<string>();
  const categories: Category[] = value.categories.map((c: unknown) => {
    assert(record(c) && typeof c.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) && !ids.has(c.id), 'Each category needs a unique ID.');
    assert(typeof c.name === 'string' && c.name.trim().length > 0 && c.name.trim().length <= 40 && !names.has(c.name.trim().toLowerCase()), 'Give each category a different name (1–40 characters).');
    assert(COLORS.includes(c.color) && typeof c.enabled === 'boolean' && typeof c.fallback === 'boolean' && ['all', 'any'].includes(c.mode), 'Invalid category appearance or matching mode.');
    assert(Array.isArray(c.conditions) && c.conditions.length <= 20 && (c.fallback ? c.conditions.length === 0 && c.enabled : c.conditions.length > 0), 'Keep the fallback enabled and give every other category at least one condition.');
    const conditions: Condition[] = c.conditions.map((r: unknown) => {
      assert(record(r) && ['label', 'feedback', 'approval', 'changes', 'draft'].includes(r.kind) && typeof r.negate === 'boolean', 'Invalid matching condition.');
      if (r.kind === 'label') assert(typeof r.value === 'string' && r.value.trim().length > 0 && r.value.trim().length <= 100, 'Enter a label name (1–100 characters).');
      return { kind: r.kind, negate: r.negate, ...(r.kind === 'label' ? { value: r.value.trim() } : {}) };
    });
    ids.add(c.id); names.add(c.name.trim().toLowerCase());
    return { id: c.id, name: c.name.trim(), color: c.color, enabled: c.enabled, fallback: c.fallback, mode: c.mode, conditions };
  });
  assert(categories.filter(c => c.fallback).length === 1, 'Exactly one fallback category is required.');
  const normal = categories.filter(c => !c.fallback).map(c => c.id);
  assert(Array.isArray(value.priority) && value.priority.length === normal.length && new Set(value.priority).size === normal.length && value.priority.every((id: unknown) => typeof id === 'string' && normal.includes(id)), 'Rule priority must include each non-fallback category once.');
  return { version: 1, enabled: value.enabled, token: value.token.trim(), connections: connections.map(c => ({ owner: c.owner, token: c.token.trim() })), ignoredLogins: [...new Set<string>(value.ignoredLogins.map((s: string) => s.toLowerCase()))], categories, priority: [...value.priority] };
}
