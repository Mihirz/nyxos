// A virtual refreshable braille display: 40 cells, 8 dots each, mirroring every
// word Callbacks speaks. Pan left/right with the arrows, like the thumb keys on
// a real Focus/Brailliant display.

import { useEffect, useState } from 'react';
import { cellDots, paginate } from '../../core/braille';
import { BrailleIcon } from './Icons';

const CELLS = 40;
// Dot layout in a cell: 1 4 / 2 5 / 3 6 / 7 8
const ORDER = [0, 3, 1, 4, 2, 5, 6, 7];

export function BrailleDisplay({ braille, text }: { braille: string; text: string }) {
  const rows = paginate(braille || '⠀', CELLS);
  const [row, setRow] = useState(0);
  useEffect(() => setRow(0), [braille]);
  const cells = [...(rows[row] ?? '')];

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
      <div className="braille-text" aria-hidden>{text}</div>
    </section>
  );
}
