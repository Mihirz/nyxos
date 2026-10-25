// A virtual refreshable braille display: 40 cells, 8 dots each, showing a condensed form of
// what's on screen (the page and its options). Pan with the arrows, like the thumb keys on a
// real Focus/Brailliant display. Under the cells, the same line in print, for sighted helpers.

import { useEffect, useMemo, useState } from 'react';
import { brailleLines, cellDots } from '../../core/braille';
import { BrailleIcon } from './Icons';

const CELLS = 40;
// Dot layout in a cell: 1 4 / 2 5 / 3 6 / 7 8
const ORDER = [0, 3, 1, 4, 2, 5, 6, 7];

export function BrailleDisplay({ text }: { text: string }) {
  const rows = useMemo(() => brailleLines(text || ' ', CELLS), [text]);
  const [row, setRow] = useState(0);
  useEffect(() => setRow(0), [text]);
  const line = rows[Math.min(row, rows.length - 1)];
  const cells = [...line.braille.padEnd(CELLS, '⠀')].slice(0, CELLS);

  return (
    <section className="braille" aria-label="Braille display">
      <header>
        <BrailleIcon />
        <span>BRAILLE · UEB grade 2 · {CELLS} cells</span>
        <span className="pan">
          <button onClick={() => setRow((r) => Math.max(0, r - 1))} aria-label="Pan left">◀</button>
          {row + 1}/{rows.length}
          <button onClick={() => setRow((r) => Math.min(rows.length - 1, r + 1))} aria-label="Pan right">▶</button>
        </span>
      </header>
      <div className="cells">
        {cells.map((c, i) => {
          const d = cellDots(c);
          return (
            <div className="cell" key={i} title={c}>
              {ORDER.map((idx) => <i key={idx} className={d[idx] ? 'up' : ''} />)}
            </div>
          );
        })}
      </div>
      <div className="braille-print" aria-hidden>{line.print}</div>
    </section>
  );
}
