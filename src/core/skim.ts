// Non-visual skimming, after Ahmed et al., "Accessible Skimming: Faster Screen Reading of Web
// Pages" (UIST 2012): a sighted reader's eye jumps to the sentences that carry a page; a screen
// reader user hears everything in order. This picks the key sentences of an article (frequent
// content words, opening sentences of paragraphs) and returns them in document order, so the
// user hears the gist in a fraction of the time and can drill into the full text.

const STOP = new Set(`a an the and or but if then than so of to in on at by for with from as is are was were be been being it its this that these those he she they we you i his her their our your my me him them us not no do does did done have has had having will would can could should may might must shall about into over after before more most other some such only own same too very just also there here when where which who whom what why how all any both each few nor off out up down again further once one two three said says say per via`.split(/\s+/));

const words = (s: string) => s.toLowerCase().match(/[a-z][a-z'’-]+/g) ?? [];

export interface Skim { sentences: string[]; total: number }

/**
 * The key sentences of a text. `ratio` is how much to keep (0.15 ≈ one sentence in seven);
 * at least `min` and at most `max` sentences, always in their original order.
 */
export function skim(text: string, ratio = 0.15, min = 3, max = 8): Skim {
  const paragraphs = text.split(/\n\s*\n|\n(?=[A-Z])/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 40);
  const all: Array<{ s: string; para: number; first: boolean }> = [];
  paragraphs.forEach((p, para) => {
    const ss = p.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [p];
    ss.map((s) => s.trim()).filter((s) => s.split(' ').length >= 5).forEach((s, i) => all.push({ s, para, first: i === 0 }));
  });
  if (!all.length) return { sentences: [], total: 0 };

  // Content-word frequency across the whole text: the words a page keeps coming back to.
  const freq = new Map<string, number>();
  for (const { s } of all) for (const w of words(s)) if (!STOP.has(w) && w.length > 2) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = Math.max(1, ...freq.values());

  const scored = all.map((x, i) => {
    const ws = words(x.s).filter((w) => !STOP.has(w) && w.length > 2);
    const density = ws.reduce((n, w) => n + (freq.get(w) ?? 0) / top, 0) / Math.max(4, Math.sqrt(ws.length) * 2);
    // Lead sentences of paragraphs carry their topic; the article's opening carries the most.
    const position = (x.first ? 0.35 : 0) + (x.para === 0 ? 0.25 : 0) + (i === 0 ? 0.4 : 0);
    // Very long sentences take long to hear; very short ones rarely carry the point.
    const length = x.s.length > 280 ? -0.25 : x.s.length < 50 ? -0.15 : 0;
    return { i, s: x.s, score: density + position + length };
  });

  const keep = Math.max(min, Math.min(max, Math.round(all.length * ratio)));
  const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, keep).sort((a, b) => a.i - b.i);
  return { sentences: chosen.map((c) => c.s), total: all.length };
}
