// How nyxOS speaks lists of choices. A blind user can't glance at a menu, so
// every list is a title and a few short labels, no numbers, capped so it fits in
// a breath: "Amazon: Search, Primary nav, Main, Recently viewed, and 2 more."
// The user picks by saying a label (or a number; the screen shows them).
// The screen shows full labels; speech gets the compact form.

export type Level = 'system' | 'app' | 'content' | 'web' | 'messages';

export interface OptionItem<A = unknown> {
  label: string;
  detail?: string;
  /** Spoken form, when it should differ from the compacted label. */
  say?: string;
  action: A;
}

/** Options read per breath: 3 when brief, 5 normally, 8 when detailed (user-controlled verbosity). */
export let MAX_SPOKEN_OPTIONS = 5;
export const setSpokenOptions = (n: number) => { MAX_SPOKEN_OPTIONS = n; };

const TRAILING_FILLER = /\s+(and|or|of|the|for|to|with|on|in|a|an|at|by|from|your|&)$/i;

/** "Show/hide shortcuts, shift, option, z" → "Show/hide shortcuts"; long labels cut to a few words. */
export function compact(label: string, maxWords = 4): string {
  let s = label.split(/\s[|•·–—-]\s|,\s|:\s|\.\s/)[0].trim() || label.trim();
  const words = s.split(/\s+/);
  if (words.length > maxWords) {
    s = words.slice(0, maxWords).join(' ');
    while (TRAILING_FILLER.test(s)) s = s.replace(TRAILING_FILLER, '');
  }
  return s;
}

export function speakOptions(title: string, items: OptionItem[], offset = 0): string {
  if (!items.length) return `${title}: none.`;
  const labels = items.slice(offset, offset + MAX_SPOKEN_OPTIONS).map((it) => it.say ?? compact(it.label));
  const left = items.length - offset - labels.length;
  const body = left > 0 ? `${labels.join(', ')}, and ${left} more` : labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
  return offset === 0 && title ? `${title}: ${body}.` : `${body}.`;
}

/** "Amazon.com. Spend less. Smile more." → "Amazon"; "Issues · anthropics/sdk - GitHub" → "Issues". */
export function shortPageTitle(title: string): string {
  const first = title.split(/\s[|•·–—-]\s|[.:!]\s/)[0].trim() || title;
  return compact(first.replace(/\.(com|org|net|io|ai|dev|co)$/i, ''), 5);
}

export const LEVEL_NAMES: Record<Level, string> = {
  system: 'Windows',
  app: 'App',
  content: 'Content',
  web: 'Web',
  messages: 'Messages',
};
