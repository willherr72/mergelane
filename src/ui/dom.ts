import type { PublicState } from '../storage';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
export function button(text: string, className: string, action: () => void, label?: string): HTMLButtonElement {
  const b = el('button', className, text); b.type = 'button'; b.onclick = action;
  if (label) b.setAttribute('aria-label', label);
  return b;
}
const paths: Record<string, string> = {
  merge: 'M7 6v12M17 6v2c0 5-10 3-10 8M5 4a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 4a2 2 0 1 0 4 0a2 2 0 1 0-4 0M5 20a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  progress: 'M12 4a8 8 0 1 0 8 8M12 8v4l3 2M16 5h.01M19 8h.01',
  feedback: 'M5 5h14v10H9l-4 4zM9 9h6M9 12h4',
  approval: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M8 12l3 3 5-6',
  label: 'M3 3l8 .5L21 14l-7 7L3.5 11zM8 7a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  plus: 'M12 5v14M5 12h14',
  window: 'M3 7q0-3 3-3h12q3 0 3 3v10q0 3-3 3H6q-3 0-3-3zM3 9h18M7 6.5h1M11 6.5h1',
  archive: 'M3 3h18v5H3zM5 8v12h14V8M9 12h6',
  link: 'M10 14l4-4M8 16l-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M16 8l1-1a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0',
};
export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true })) svg.setAttribute(key, String(value));
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] ?? paths.label); svg.append(path); return svg;
}
export async function send(type: string, data: Record<string, unknown> = {}): Promise<PublicState> {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error ?? 'MergeLane could not respond. Reload the extension and try again.');
  return result.data;
}
export function relativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Not checked yet';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? 'Checked just now' : seconds < 3600 ? `Checked ${Math.floor(seconds / 60)}m ago` : `Checked ${Math.floor(seconds / 3600)}h ago`;
}
export function showError(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
