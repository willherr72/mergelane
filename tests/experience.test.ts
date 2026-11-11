import { expect, it } from 'vitest';
import { classify, explainCategory } from '../src/core/classify';
import { defaultSettings } from '../src/core/settings';
import { addClosure, setProtection, emptyCleanup, canonicalPr } from '../src/core/cleanup';
import { healthFromRun } from '../src/core/health';
import { emptyStatus, type Facts } from '../src/core/model';

const facts: Facts = { labels: ['mergify-queue'], feedback: true, approval: true, changes: false, draft: false };
it('explains the winning rule rather than a lower priority matching rule', () => {
  const settings = defaultSettings(); const id = classify(facts, settings);
  expect(explainCategory(settings.categories.find(c => c.id === id)!, facts)).toBe('Has label “mergify-queue”.');
  settings.categories.find(c => c.id === 'merging')!.enabled = false;
  expect(explainCategory(settings.categories.find(c => c.id === classify(facts, settings))!, facts)).toContain('Active human approval');
});
it('explains only matching any-conditions, including negation, and makes fallback explicit', () => {
  const category = { ...defaultSettings().categories[3], mode: 'any' as const, conditions: [{ kind: 'label' as const, value: 'missing', negate: false }, { kind: 'draft' as const, negate: true }] };
  expect(explainCategory(category, facts)).toBe('Not a draft.');
  expect(explainCategory(defaultSettings().categories[0], facts)).toContain('No enabled rule matched');
});
it('bounds and deduplicates recent closures without removing persistent protections', () => {
  let state = setProtection(emptyCleanup(), canonicalPr('https://github.com/org/repo/pull/1/files', 'Example'), true);
  for (let n = 1; n <= 35; n++) state = addClosure(state, { ...canonicalPr(`https://github.com/org/repo/pull/${n}`, ''), closedAt: n, reason: 'merged' });
  expect(state.recent).toHaveLength(30); expect(state.kept).toHaveLength(1);
  state = addClosure(state, { ...canonicalPr('https://github.com/org/repo/pull/35', 'Again'), closedAt: 40, reason: 'merged' });
  expect(state.recent).toHaveLength(30); expect(state.recent[0].title).toBe('Again');
  expect(setProtection(state, state.kept[0], false).kept).toEqual([]);
  expect(state.kept[0].url).toBe('https://github.com/org/repo/pull/1');
  expect(() => canonicalPr('https://evil.test/', '')).toThrow('GitHub PR');
});
it('updates only checked owner health and keeps healthy owners independent', () => {
  const settings = { ...defaultSettings(), connections: [{ owner: 'A', token: 'a' }, { owner: 'b', token: 'b' }, { owner: 'c', token: 'c' }] };
  const status = { ...emptyStatus(), owners: ['a', 'b'], errors: [{ pr: 'a/repo/1', message: 'Needs access' }] };
  expect(healthFromRun([], settings, status, 100)).toEqual([{ owner: 'a', status: 'error', checkedAt: 100, message: 'Needs access' }, { owner: 'b', status: 'verified', checkedAt: 100, message: 'Access verified for open PR tabs.' }]);
});
