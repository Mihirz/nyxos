// The iOS app runs the desktop's pure-TypeScript core in JavaScriptCore, so the command grammar,
// spoken-list narration, braille, Lens page scripts and URL helpers are byte-for-byte the same
// code as the desktop app. Bundled by ios/scripts/bundle-core.sh into nyxOS/Resources/nyxcore.js.
// Nothing here is edited by hand except the small helpers copied below.

export { parseCommand, parseNumber, normalizeKeys, isInstant, SHORTCODES } from '../../src/core/commands';
export { compact, speakOptions, shortPageTitle, setSpokenOptions } from '../../src/core/narration';
export { skim } from '../../src/core/skim';
export { toBraille, brailleLines, cellDots } from '../../src/core/braille';
export {
  EXTRACT_JS, activateJs, fillJs, SUBMIT_JS, scrollJs, findJs, clickTextJs, clickPointJs, STOP_CLICKS_JS,
  WATCH_JS, WATCH_TAKE_JS, lookJs, hoverJs, scrollByJs, highlightJs,
} from '../../src/renderer/lens/extract';
// web.ts also imports linkedom/readability for performance mode; those are stubbed out at bundle
// time (the iOS app fetches text-only pages in Swift). Only the pure helpers are used.
export { normalizeUrl, searchUrl, knownSite, isKnownSite, looksLikeUrl, gameUrl } from '../../src/main/web';

// ---- copied from src/main/system.ts (that file imports Electron and node:fs, so it can't be bundled)
// Accent-insensitive: "Möbius" matches "mobius".
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** 100 exact, 80 prefix, 70 word prefix, 60 substring, up to 40 for partial word overlap. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = norm(query), k = norm(candidate);
  if (!q || !k) return 0;
  if (k === q) return 100;
  if (k.startsWith(q)) return 80;
  if (k.split(' ').some((w) => w.startsWith(q))) return 70;
  if (k.includes(q)) return 60;
  const qw = q.split(' ');
  const hits = qw.filter((w) => k.includes(w)).length;
  return hits ? 40 * (hits / qw.length) : 0;
}

export function spokenKeys(combo: string): string {
  const names: Record<string, string> = { cmd: 'command', ctrl: 'control', alt: 'option', return: 'enter' };
  return combo.split('+').map((k) => names[k] ?? k).join(' ');
}
