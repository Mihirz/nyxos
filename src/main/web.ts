// Performance-mode web: fetch over HTTP and extract structure in Node. No
// rendering engine, no JavaScript, no ads, no layout: just the outline a screen
// reader user navigates. Runs fine with the display off.

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type { LensItem, LensPage } from '../shared/types';

export function normalizeUrl(input: string): string {
  const s = input.trim()
    .replace(/\s+dot\s+/gi, '.')
    .replace(/^(localhost|[\w-]+(?:\.[\w-]+)+)(?:\s+colon)?\s+(\d{2,5})\b/i, '$1:$2') // "localhost 3000"
    .replace(/\s+slash\s+/gi, '/')
    .replace(/\s+/g, '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?/i.test(s)) return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`;
  return searchUrl(input);
}

export const searchUrl = (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

// Sites people name like apps ("go to amazon"). Anything else that isn't an
// installed app goes through DuckDuckGo's first-result redirect.
const KNOWN_SITES: Record<string, string> = {
  amazon: 'amazon.com', youtube: 'youtube.com', google: 'google.com', gmail: 'mail.google.com', github: 'github.com',
  wikipedia: 'en.wikipedia.org', reddit: 'reddit.com', twitter: 'x.com', x: 'x.com', facebook: 'facebook.com',
  instagram: 'instagram.com', linkedin: 'linkedin.com', netflix: 'netflix.com', ebay: 'ebay.com', target: 'target.com',
  walmart: 'walmart.com', yelp: 'yelp.com', 'hacker news': 'news.ycombinator.com', 'stack overflow': 'stackoverflow.com',
  'google maps': 'maps.google.com', 'google docs': 'docs.google.com', 'google drive': 'drive.google.com',
  'cookie clicker': 'orteil.dashnet.org/cookieclicker/', connections: 'nytimes.com/games/connections', 'nyt connections': 'nytimes.com/games/connections', wordle: 'nytimes.com/games/wordle/index.html', 'spend bill gates money': 'neal.fun/spend/', 'new york times': 'nytimes.com', nytimes: 'nytimes.com', cnn: 'cnn.com', bbc: 'bbc.com', espn: 'espn.com', claude: 'claude.ai',
};

/** "amazon" → https://amazon.com, "the new york times" → https://www.nytimes.com/ (first search result). */
const siteCache = new Map<string, string>();

export async function resolveSite(name: string): Promise<string> {
  const key = name.toLowerCase().replace(/^the /, '').replace(/ (website|site|dot com)$/, '').trim();
  const game = gameUrl(key);
  if (game) return resolveGame(game);
  const known = knownSite(key);
  if (known) return `https://${known}`;
  const hit = siteCache.get(key);
  if (hit) return hit;
  const url = await lookupSite(key);
  if (!url.includes('duckduckgo.com/html')) siteCache.set(key, url);
  return url;
}

async function lookupSite(key: string): Promise<string> {
  try {
    const html = await (await fetch(`https://duckduckgo.com/?q=${encodeURIComponent('\\ ' + key)}`, { signal: AbortSignal.timeout(4000) })).text();
    const m = html.match(/uddg=([^&'"]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch { /* offline */ }
  return searchUrl(key);
}

/** Edit distance, for misheard site names ("cookie cocker" → cookie clicker). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** The known site a spoken name means, allowing a couple of misheard letters on longer names. */
export function knownSite(name: string): string | null {
  const key = name.toLowerCase().replace(/^the /, '').replace(/ (website|site|dot com)$/, '').trim();
  if (KNOWN_SITES[key]) return KNOWN_SITES[key];
  if (key.length < 6) return null;
  let best: string | null = null, bestD = 99;
  for (const k of Object.keys(KNOWN_SITES)) {
    const dd = distance(key, k);
    // About one misheard letter in four ("cookie cooker" → cookie clicker).
    if (k.length >= 6 && dd < bestD + 1 && dd <= Math.floor(k.length / 4) && (best == null || dd < bestD)) { best = k; bestD = dd; }
  }
  return best ? KNOWN_SITES[best] : null;
}

export const isKnownSite = (name: string) => Boolean(knownSite(name)) || Boolean(gameUrl(name));

/**
 * Games open straight to a playable board, not a landing page or games menu: "go to crosswords"
 * means "let me play one". Keys are normalized so "cross words" and "crosswords" match.
 */
const GAMES: Record<string, string> = {
  // Free every day (NYT's Mini now needs a subscription): resolved to today's puzzle number.
  crossword: 'latest:guardian-quick', 'quick crossword': 'latest:guardian-quick', 'guardian crossword': 'latest:guardian-quick',
  'mini crossword': 'https://www.nytimes.com/crosswords/game/mini', 'the mini': 'https://www.nytimes.com/crosswords/game/mini', wordle: 'https://www.nytimes.com/games/wordle/index.html',
  connections: 'https://www.nytimes.com/games/connections', 'spelling bee': 'https://www.nytimes.com/puzzles/spelling-bee',
  strands: 'https://www.nytimes.com/games/strands', sudoku: 'https://www.nytimes.com/puzzles/sudoku/easy',
  chess: 'https://lichess.org/', 2048: 'https://play2048.co/', 'cookie clicker': 'https://orteil.dashnet.org/cookieclicker/',
  'spend bill gates money': 'https://neal.fun/spend/', akinator: 'https://en.akinator.com/',
};
const squash = (s: string) => s.toLowerCase().replace(/^(the|a|some|play|a game of)\s+/g, '').replace(/\s+game$/, '').replace(/[^a-z0-9]/g, '').replace(/s$/, '');

/** Games whose address changes daily ("latest:…") resolve to today's puzzle. */
export async function resolveGame(url: string): Promise<string> {
  if (url === 'latest:guardian-quick') {
    try {
      const html = await (await fetch('https://www.theguardian.com/crosswords/series/quick', { signal: AbortSignal.timeout(5000) })).text();
      const m = html.match(/\/crosswords\/quick\/(\d+)/);
      if (m) return `https://www.theguardian.com/crosswords/quick/${m[1]}`;
    } catch { /* offline: fall back to the series page */ }
    return 'https://www.theguardian.com/crosswords/series/quick';
  }
  return url;
}

export function gameUrl(name: string): string | null {
  const k = squash(name);
  if (!k) return null;
  for (const [g, url] of Object.entries(GAMES)) if (squash(g) === k) return url;
  return null;
}

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|localhost|[\w-]+(\.|\s+dot\s+)(com|org|net|edu|io|dev|ai|app|gov|co|me)\b)/i.test(s.trim());
}

export async function fetchPage(url: string): Promise<LensPage> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) nyxOS/0.1 (accessibility reader)', Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  const html = await res.text();
  const { document } = parseHTML(html);
  const base = res.url || url;
  const abs = (href: string) => { try { return new URL(href, base).href; } catch { return href; } };

  const items: LensItem[] = [];
  let n = 0;
  const id = () => `t${++n}`;
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  // DuckDuckGo HTML results get first-class treatment: they are the search UI.
  const results = [...document.querySelectorAll('a.result__a')];
  if (results.length) {
    for (const a of results.slice(0, 15)) {
      const snippet = a.closest('.result')?.querySelector('.result__snippet');
      items.push({ id: id(), kind: 'result', label: text(a) + (snippet ? ` — ${text(snippet).slice(0, 160)}` : ''), href: decodeDdg(abs(a.getAttribute('href') ?? '')) });
    }
  }
  for (const h of document.querySelectorAll('h1,h2,h3')) {
    const label = text(h);
    if (label) items.push({ id: id(), kind: 'heading', level: Number(h.tagName[1]), label: label.slice(0, 140) });
  }
  if (!results.length) {
    const seen = new Set<string>();
    for (const a of document.querySelectorAll('a[href]')) {
      const label = text(a) || a.getAttribute('aria-label') || '';
      const href = abs(a.getAttribute('href') ?? '');
      if (!label || href.startsWith('javascript:') || seen.has(href)) continue;
      seen.add(href);
      items.push({ id: id(), kind: 'link', label: label.slice(0, 120), href });
      if (seen.size > 150) break;
    }
  }

  let article = '';
  try {
    const parsed = new Readability(document as unknown as Document).parse();
    article = (parsed?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  } catch { /* not an article */ }
  if (!article) article = text(document.querySelector('main') ?? document.body ?? document.documentElement).slice(0, 20000);

  return { url: base, title: text(document.querySelector('title') ?? document.documentElement).slice(0, 140) || base, items, article: article.slice(0, 40000), textOnly: true };
}

function decodeDdg(href: string): string {
  try {
    const u = new URL(href);
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}
