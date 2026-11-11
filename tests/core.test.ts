import { describe, expect, it } from 'vitest';
import { parsePrUrl } from '../src/core/url';
import { defaultSettings, validateSettings } from '../src/core/settings';
import { deriveFacts, classify, shouldClose } from '../src/core/classify';

const human = (login: string) => ({ login, type: 'User' });
const detail = { state: 'open', merged: false, closed_at: null, draft: false, user: human('author'), labels: [] };
const snapshot = (reviews: any[] = [], comments: any[] = []) => ({ details: detail, comments, reviewComments: [], reviews });
const review = (state: string, date: number, login = 'reviewer') => ({ id: date, user: human(login), state, submitted_at: new Date(date * 1000).toISOString() });

describe('PR identity', () => {
  it('deduplicates PR subpages and ignores query/fragment', () => {
    expect(parsePrUrl('https://github.com/Org/Repo/pull/42/files?diff=split#x')).toEqual({ owner: 'Org', repo: 'Repo', number: 42, key: 'org/repo/42' });
  });
  it.each(['https://github.com.evil.test/a/b/pull/1', 'https://github.com/a/b/pulls', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1oops', 'https://evil@github.com/a/b/pull/1', 'http://github.com/a/b/pull/1', undefined])('rejects non-PR URL %s', url => expect(parsePrUrl(url)).toBeNull());
});

describe('human review facts', () => {
  it('excludes authors, bot identities, bot logins, ignored users and unknown users', () => {
    const s = snapshot([], [{ user: human('AUTHOR') }, { user: { login: 'agent', type: 'Bot' } }, { user: human('agent[bot]') }, { user: human('automation') }, { user: null }]);
    expect(deriveFacts(s, ['AUTOMATION']).feedback).toBe(false);
    s.reviewComments = [{ user: human('alice') }] as never[];
    expect(deriveFacts(s, []).feedback).toBe(true);
  });
  it('keeps approval after a comment-only review, but not after dismissal', () => {
    expect(deriveFacts(snapshot([review('APPROVED', 1), review('COMMENTED', 2)]), []).approval).toBe(true);
    expect(deriveFacts(snapshot([review('APPROVED', 1), review('DISMISSED', 2)]), []).approval).toBe(false);
  });
  it('uses chronological decisive review state and blocks approval for outstanding changes', () => {
    expect(deriveFacts(snapshot([review('CHANGES_REQUESTED', 3), review('APPROVED', 1)]), []).changes).toBe(true);
    expect(deriveFacts(snapshot([review('APPROVED', 4), review('CHANGES_REQUESTED', 3)]), []).approval).toBe(true);
    expect(deriveFacts(snapshot([review('APPROVED', 1), review('CHANGES_REQUESTED', 2, 'bob')]), []).approval).toBe(false);
    expect(deriveFacts(snapshot([{ ...review('APPROVED', 1), submitted_at: null }]), []).approval).toBe(false);
  });
});

describe('configurable classification', () => {
  it('keeps display ordering independent of rule priority and falls back as conditions change', () => {
    const s = defaultSettings();
    const f = { labels: ['mergify-queue'], feedback: true, approval: true, changes: false, draft: false };
    expect(classify(f, s)).toBe('merging');
    s.categories.reverse();
    expect(classify(f, s)).toBe('merging');
    expect(classify({ ...f, labels: [] }, s)).toBe('approved');
    expect(classify({ ...f, labels: [], approval: false }, s)).toBe('review');
    expect(classify({ ...f, labels: [], approval: false, feedback: false }, s)).toBe('progress');
  });
  it('supports custom names, labels, all/any, disabled rules and negative predicates', () => {
    const s = defaultSettings();
    s.categories.find(c => c.id === 'merging')!.conditions = [{ kind: 'label', value: 'READY', negate: false }, { kind: 'draft', negate: true }];
    const f = { labels: ['ready'], feedback: false, approval: false, changes: false, draft: true };
    expect(classify(f, s)).toBe('progress');
    s.categories.find(c => c.id === 'merging')!.mode = 'any';
    expect(classify(f, s)).toBe('merging');
    s.categories.find(c => c.id === 'merging')!.enabled = false;
    expect(classify(f, s)).toBe('progress');
  });
  it('rejects broken configuration rather than silently weakening it', () => {
    const s = defaultSettings();
    expect(s.enabled).toBe(false);
    expect(validateSettings(s)).toEqual(s);
    expect(() => validateSettings({ ...s, categories: [] })).toThrow();
    expect(() => validateSettings({ ...s, version: 99 })).toThrow();
    s.categories[1].name = ' in progress ';
    expect(() => validateSettings(s)).toThrow();
    const t = defaultSettings(); t.categories[0].enabled = false;
    expect(() => validateSettings(t)).toThrow();
    const u = defaultSettings(); u.priority = ['merging'];
    expect(() => validateSettings(u)).toThrow();
  });
});

describe('cleanup eligibility', () => {
  const now = Date.parse('2026-11-10T18:00:00Z');
  it('requires strictly more than one hour and the most recent closure', () => {
    expect(shouldClose({ ...detail, state: 'closed', closed_at: '2026-11-10T17:00:00Z' }, now)).toBe(false);
    expect(shouldClose({ ...detail, state: 'closed', closed_at: '2026-11-10T16:59:59Z' }, now)).toBe(true);
    expect(shouldClose({ ...detail, state: 'closed', closed_at: '2026-11-10T17:30:00Z' }, now)).toBe(false);
  });
  it('keeps reopened and malformed PRs but immediately recognizes a confirmed merge', () => {
    expect(shouldClose({ ...detail, closed_at: '2026-11-10T16:00:00Z' }, now)).toBe(false);
    expect(shouldClose({ ...detail, state: 'closed', closed_at: 'bad' }, now)).toBe(false);
    expect(shouldClose({ ...detail, state: 'closed', closed_at: null }, now)).toBe(false);
    expect(shouldClose({ ...detail, state: 'closed', merged: true }, now)).toBe(true);
  });
});
