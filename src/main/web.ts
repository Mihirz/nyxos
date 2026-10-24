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

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|localhost|[\w-]+(\.|\s+dot\s+)(com|org|net|edu|io|dev|ai|app|gov|co|me)\b)/i.test(s.trim());
}

export async function fetchPage(url: string): Promise<LensPage> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Callbacks/0.1 (accessibility reader)', Accept: 'text/html' },
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
