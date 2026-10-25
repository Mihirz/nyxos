// Text → Unified English Braille (Unicode braille patterns, U+2800 block).
//
// Grade 1 is letter-for-letter. Grade 2 here applies the common UEB wordsigns and
// strong groupsigns, enough to be recognizably contracted, not a certified
// transcriber. Every string nyxOS speaks is also pushed through this pipeline
// to whatever BrailleDriver is attached (the on-screen virtual display by default).

const dots = (...ds: number[]) => String.fromCharCode(0x2800 + ds.reduce((acc, d) => acc | (1 << (d - 1)), 0));

const LETTERS: Record<string, string> = {
  a: dots(1), b: dots(1, 2), c: dots(1, 4), d: dots(1, 4, 5), e: dots(1, 5), f: dots(1, 2, 4),
  g: dots(1, 2, 4, 5), h: dots(1, 2, 5), i: dots(2, 4), j: dots(2, 4, 5), k: dots(1, 3),
  l: dots(1, 2, 3), m: dots(1, 3, 4), n: dots(1, 3, 4, 5), o: dots(1, 3, 5), p: dots(1, 2, 3, 4),
  q: dots(1, 2, 3, 4, 5), r: dots(1, 2, 3, 5), s: dots(2, 3, 4), t: dots(2, 3, 4, 5),
  u: dots(1, 3, 6), v: dots(1, 2, 3, 6), w: dots(2, 4, 5, 6), x: dots(1, 3, 4, 6),
  y: dots(1, 3, 4, 5, 6), z: dots(1, 3, 5, 6),
};
const DIGITS = 'jabcdefghi'; // 0-9 reuse a-j after the numeric indicator
const NUMBER_SIGN = dots(3, 4, 5, 6);
const CAPITAL_SIGN = dots(6);
const CAPITAL_WORD = dots(6) + dots(6);

const PUNCT: Record<string, string> = {
  ',': dots(2), ';': dots(2, 3), ':': dots(2, 5), '.': dots(2, 5, 6), '!': dots(2, 3, 5),
  '?': dots(2, 3, 6), "'": dots(3), '-': dots(3, 6), '"': dots(2, 3, 6), '“': dots(2, 3, 6), '”': dots(3, 5, 6),
  '(': dots(5) + dots(1, 2, 6), ')': dots(5) + dots(3, 4, 5), '/': dots(4, 5, 6) + dots(3, 4),
  '@': dots(4) + dots(1), '#': dots(4, 5, 6) + dots(1, 4, 5, 6), '&': dots(4) + dots(1, 2, 3, 4, 6),
  '*': dots(5) + dots(3, 5), '+': dots(5) + dots(2, 3, 5), '=': dots(5) + dots(2, 3, 5, 6),
  '<': dots(4) + dots(1, 2, 6), '>': dots(4) + dots(3, 4, 5), '_': dots(4, 6) + dots(3, 6),
  '[': dots(4, 6) + dots(1, 2, 6), ']': dots(4, 6) + dots(3, 4, 5), '{': dots(4, 5, 6) + dots(1, 2, 6),
  '}': dots(4, 5, 6) + dots(3, 4, 5), '$': dots(4) + dots(2, 3, 4), '%': dots(4, 6) + dots(3, 5, 6),
  '\n': dots(), ' ': dots(),
};

// Grade 2: whole-word contractions.
const WORDSIGNS: Record<string, string> = {
  and: dots(1, 2, 3, 4, 6), for: dots(1, 2, 3, 4, 5, 6), of: dots(1, 2, 3, 5, 6), the: dots(2, 3, 4, 6),
  with: dots(2, 3, 4, 5, 6), but: LETTERS.b, can: LETTERS.c, do: LETTERS.d, every: LETTERS.e,
  from: LETTERS.f, go: LETTERS.g, have: LETTERS.h, just: LETTERS.j, knowledge: LETTERS.k,
  like: LETTERS.l, more: LETTERS.m, not: LETTERS.n, people: LETTERS.p, quite: LETTERS.q,
  rather: LETTERS.r, so: LETTERS.s, that: LETTERS.t, us: LETTERS.u, very: LETTERS.v,
  will: LETTERS.w, it: LETTERS.x, you: LETTERS.y, as: LETTERS.z,
};
// Grade 2: groupsigns usable inside words. Longest first.
const GROUPSIGNS: Array<[string, string]> = [
  ['ing', dots(3, 4, 6)], ['and', dots(1, 2, 3, 4, 6)], ['the', dots(2, 3, 4, 6)], ['for', dots(1, 2, 3, 4, 5, 6)],
  ['ch', dots(1, 6)], ['sh', dots(1, 4, 6)], ['th', dots(1, 4, 5, 6)], ['wh', dots(1, 5, 6)],
  ['ou', dots(1, 2, 5, 6)], ['st', dots(3, 4)], ['ed', dots(1, 2, 4, 6)], ['er', dots(1, 2, 4, 5, 6)],
  ['ar', dots(3, 4, 5)], ['ow', dots(2, 4, 6)], ['gh', dots(1, 2, 6)],
];

export type Grade = 1 | 2;

function letters(word: string, grade: Grade): string {
  let out = '';
  let i = 0;
  const lower = word.toLowerCase();
  while (i < lower.length) {
    if (grade === 2) {
      const g = GROUPSIGNS.find(([seq]) => lower.startsWith(seq, i));
      if (g) { out += g[1]; i += g[0].length; continue; }
    }
    out += LETTERS[lower[i]] ?? '';
    i++;
  }
  return out;
}

function encodeWord(word: string, grade: Grade): string {
  const lower = word.toLowerCase();
  const isAllCaps = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
  const prefix = isAllCaps ? CAPITAL_WORD : /^[A-Z]/.test(word) ? CAPITAL_SIGN : '';
  if (grade === 2 && WORDSIGNS[lower]) return prefix + WORDSIGNS[lower];
  if (!isAllCaps && /[A-Z]/.test(word.slice(1))) {
    // camelCase: mark each capital individually, which matters for reading code.
    return [...word].map((ch) => (/[A-Z]/.test(ch) ? CAPITAL_SIGN : '') + letters(ch, 1)).join('');
  }
  return prefix + letters(word, grade);
}

export function toBraille(text: string, grade: Grade = 2): string {
  let out = '';
  const tokens = text.match(/[A-Za-z]+|\d+(?:[.,]\d+)*|\s+|./gsu) ?? [];
  for (const tok of tokens) {
    if (/^[A-Za-z]+$/.test(tok)) out += encodeWord(tok, grade);
    else if (/^\d/.test(tok)) {
      out += NUMBER_SIGN + [...tok].map((ch) => (/\d/.test(ch) ? LETTERS[DIGITS[+ch]] : PUNCT[ch] ?? '')).join('');
    } else if (/^\s+$/.test(tok)) out += tok.includes('\n') ? '\n' : dots();
    else out += PUNCT[tok] ?? '';
  }
  return out;
}

/** Raised-dot state for rendering a cell: index 0 → dot 1 … index 7 → dot 8. */
export function cellDots(cell: string): boolean[] {
  const bits = cell.charCodeAt(0) - 0x2800;
  return Array.from({ length: 8 }, (_, i) => (bits & (1 << i)) !== 0);
}

/** Split braille text into fixed-width display rows (refreshable displays are 14–80 cells). */
/**
 * Break text into display lines of whole words whose braille fits the display, each paired with
 * its print, so a sighted helper can read along with exactly what the cells show.
 */
export function brailleLines(text: string, cells = 40, grade: 1 | 2 = 2): Array<{ print: string; braille: string }> {
  const lines: Array<{ print: string; braille: string }> = [];
  let cur = '';
  const push = () => { if (cur) lines.push({ print: cur, braille: toBraille(cur, grade) }); cur = ''; };
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (toBraille(next, grade).length <= cells) { cur = next; continue; }
    push();
    // A single word longer than the display is split across lines.
    let w = word;
    while (toBraille(w, grade).length > cells) {
      let n = w.length;
      while (n > 1 && toBraille(w.slice(0, n), grade).length > cells) n--;
      lines.push({ print: w.slice(0, n), braille: toBraille(w.slice(0, n), grade) });
      w = w.slice(n);
    }
    cur = w;
  }
  push();
  return lines.length ? lines : [{ print: '', braille: '' }];
}

export function paginate(braille: string, cells = 40): string[] {
  const rows: string[] = [];
  for (const line of braille.split('\n')) {
    for (let i = 0; i < Math.max(line.length, 1); i += cells) rows.push(line.slice(i, i + cells).padEnd(cells, dots()));
  }
  return rows;
}
