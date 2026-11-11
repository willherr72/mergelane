import type { PrRef } from './model';

export function parsePrUrl(input: string | undefined): PrRef | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
    if (!match) return null;
    const [, owner, repo, id] = match;
    const number = Number(id);
    if (!Number.isSafeInteger(number)) return null;
    return { owner, repo, number, key: `${owner}/${repo}/${number}`.toLowerCase() };
  } catch { return null; }
}
