import { expect, it } from 'vitest';
import { applySettingsAction } from '../src/core/actions';
import { defaultSettings } from '../src/core/settings';
import { validateSettings } from '../src/core/settings';

it('saving a stale category draft cannot undo a newer pause or replace the stored token', () => {
  const current = defaultSettings(); current.token = 'current-credential';
  const stale = structuredClone(current); stale.enabled = true; stale.token = 'old-credential'; stale.categories[0].name = 'Working';
  const saved = applySettingsAction(current, { type: 'saveSettings', settings: stale });
  expect(saved.enabled).toBe(false);
  expect(saved.token).toBe('current-credential');
  expect(saved.categories[0].name).toBe('Working');
});

it('pause and disconnect operate independently of an invalid unsaved rule draft', () => {
  const current = defaultSettings(); current.enabled = true; current.token = 'credential';
  const invalid = structuredClone(current); invalid.categories[3].conditions[0].value = '';
  const paused = applySettingsAction(current, { type: 'setEnabled', enabled: false, settings: invalid });
  expect(paused.enabled).toBe(false);
  expect(paused.categories[3].conditions[0].value).toBe('mergify-queue');
  const disconnected = applySettingsAction(current, { type: 'disconnect', settings: invalid });
  expect(disconnected.enabled).toBe(false); expect(disconnected.token).toBe('');
});

it('only an explicit enable action starts management, and it requires a credential', () => {
  const current = defaultSettings();
  expect(() => applySettingsAction(current, { type: 'setEnabled', enabled: true })).toThrow('Connect');
  const connected = applySettingsAction(current, { type: 'setToken', token: ' credential ' });
  expect(connected.enabled).toBe(false); expect(connected.token).toBe('credential');
  expect(applySettingsAction(connected, { type: 'setEnabled', enabled: true }).enabled).toBe(true);
});

it('keeps independent owner tokens and preserves them when saving a stale category draft', () => {
  const first = applySettingsAction(defaultSettings(), { type: 'setToken', owner: 'Org-A', token: 'first' });
  const stale = structuredClone(first);
  const second = applySettingsAction(first, { type: 'setToken', owner: 'Org-B', token: 'second' });
  const updated = applySettingsAction(second, { type: 'setToken', owner: 'org-a', token: 'replacement' });
  const saved = applySettingsAction(updated, { type: 'saveSettings', settings: stale });
  expect(saved.connections).toEqual([{ owner: 'org-a', token: 'replacement' }, { owner: 'Org-B', token: 'second' }]);
  expect(saved.token).toBe('');
  expect(applySettingsAction(saved, { type: 'setEnabled', enabled: true }).enabled).toBe(true);
});

it('removes only the requested connection and pauses when the last credential is removed', () => {
  const first = applySettingsAction(defaultSettings(), { type: 'setToken', owner: 'org', token: 'first' });
  const second = applySettingsAction({ ...first, enabled: true, token: 'legacy' }, { type: 'removeConnection', owner: 'ORG' });
  expect(second.connections).toEqual([]); expect(second.enabled).toBe(true); expect(second.token).toBe('legacy');
  const last = applySettingsAction(second, { type: 'removeConnection', owner: '' });
  expect(last.token).toBe(''); expect(last.enabled).toBe(false);
  expect(applySettingsAction(first, { type: 'disconnect' }).connections).toEqual([]);
});

it('loads legacy settings without dropping the token, and rejects duplicate owners', () => {
  const legacy: any = { ...defaultSettings(), token: 'legacy' }; delete legacy.connections;
  expect(validateSettings(legacy).connections).toEqual([]);
  expect(validateSettings(legacy).token).toBe('legacy');
  expect(() => validateSettings({ ...legacy, connections: [{ owner: 'org', token: 'a' }, { owner: 'ORG', token: 'b' }] })).toThrow('owner');
});
