// How Callbacks speaks lists of choices. A blind user can't glance at a menu, so
// every list is: count + short labels, numbered, best first, capped so it fits in
// a breath. The user picks with a number ("3"), by voice or by typing one key.

export type Level = 'system' | 'app' | 'content' | 'web' | 'messages';

export interface OptionItem<A = unknown> {
  label: string;
  detail?: string;
  action: A;
}

export const MAX_SPOKEN_OPTIONS = 7;

export function speakOptions(title: string, items: OptionItem[], offset = 0): string {
  if (!items.length) return `${title}: nothing here.`;
  const page = items.slice(offset, offset + MAX_SPOKEN_OPTIONS);
  const body = page.map((it, i) => `${offset + i + 1}, ${it.label}${it.detail ? `, ${it.detail}` : ''}`).join('. ');
  const more = items.length > offset + page.length ? ` ${items.length - offset - page.length} more, say next.` : '';
  const count = items.length === 1 ? '1 item' : `${items.length} items`;
  return offset === 0 ? `${title}, ${count}. ${body}.${more}` : `${body}.${more}`;
}

export const LEVEL_NAMES: Record<Level, string> = {
  system: 'Windows',
  app: 'App',
  content: 'Content',
  web: 'Web',
  messages: 'Messages',
};
