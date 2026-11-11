import { expect, it } from 'vitest';
import { importAllowed, selectGeneratedToken } from '../src/core/token-import';

const session = { tabId: 7, owner: 'org', expiresAt: 2000 };
const sender = { frameId: 0, url: 'https://github.com/settings/personal-access-tokens/123', tab: { id: 7, incognito: false } } as chrome.runtime.MessageSender;
const live = { id: 7, incognito: false, url: sender.url, status: 'complete' } as chrome.tabs.Tab;

it('allows only a live, unexpired setup tab on GitHub fine-grained token settings', () => {
  expect(importAllowed(session, sender, live, 1000)).toBe(true);
  expect(importAllowed(session, { ...sender, frameId: 1 }, live, 1000)).toBe(false);
  expect(importAllowed(session, { ...sender, tab: { ...live, id: 8 } }, live, 1000)).toBe(false);
  expect(importAllowed(session, sender, { ...live, incognito: true }, 1000)).toBe(false);
  expect(importAllowed(session, sender, { ...live, pendingUrl: 'https://example.com/' }, 1000)).toBe(false);
  expect(importAllowed(session, sender, { ...live, url: 'https://github.com/org/repo' }, 1000)).toBe(false);
  expect(importAllowed(session, { ...sender, url: 'https://github.com.evil.test/settings/personal-access-tokens/1' }, live, 1000)).toBe(false);
  expect(importAllowed(session, sender, live, 2000)).toBe(false);
  expect(importAllowed(undefined, sender, live, 1000)).toBe(false);
});

it('accepts one exact generated fine-grained token, not prose, masked tokens, or ambiguous results', () => {
  const token = 'github_pat_' + 'a'.repeat(60);
  expect(selectGeneratedToken([token, ` ${token} `, 'Copy token'])).toBe(token);
  expect(() => selectGeneratedToken(['Here is ' + token])).toThrow('could not find');
  expect(() => selectGeneratedToken(['github_pat_******'])).toThrow('could not find');
  expect(() => selectGeneratedToken([token, 'github_pat_' + 'b'.repeat(60)])).toThrow('more than one');
});
