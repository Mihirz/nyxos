// Single output funnel: every word Callbacks says goes through speak(), which
// drives TTS, the braille pipeline, and the on-screen transcript together.

import type { BrowserWindow } from 'electron';
import { toBraille } from '../core/braille';
import type { LogEntry, UiState } from '../shared/types';
import { synthesize, residualRate, setSayEndHandler, stopLocal } from './voice';

let win: BrowserWindow | null = null;
let logId = 0;
let speechGen = 0;
let lastSpoken = '';

export function attachWindow(w: BrowserWindow) { win = w; }

export function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export const ui: UiState = {
  status: 'idle', level: 'Windows', options: [], optionsTitle: '', rate: 1.6, curtain: false, performance: false,
  follow: false, view: 'home', providers: { claude: false, gemini: false, tts: 'say', stt: 'none' },
};

export function setUi(patch: Partial<UiState>) {
  Object.assign(ui, patch);
  send('ui', ui);
}

export function log(who: LogEntry['who'], text: string, via?: LogEntry['via'], ms?: number) {
  if (process.env.CALLBACKS_SCRIPT) console.log(`[${who}${via ? ' ' + via : ''}${ms != null ? ' ' + ms + 'ms' : ''}] ${text}`);
  send('log', { id: ++logId, at: Date.now(), who, text, via, ms } satisfies LogEntry);
}

/** Braille driver interface. The virtual display is always attached; hardware drivers plug in here. */
export interface BrailleDriver { name: string; write(cells: string): void }
const drivers: BrailleDriver[] = [{ name: 'virtual', write: (cells) => send('braille', cells) }];
export const addBrailleDriver = (d: BrailleDriver) => drivers.push(d);

export async function speak(text: string, opts: { via?: LogEntry['via']; ms?: number; quiet?: boolean } = {}) {
  if (!text) return;
  lastSpoken = text;
  const gen = ++speechGen;
  log('callbacks', text, opts.via, opts.ms);
  const cells = toBraille(text);
  for (const d of drivers) d.write(cells);
  if (opts.quiet) return;
  stopSpeech(false);
  setUi({ status: 'speaking' });
  try {
    const audio = await synthesize(text, ui.rate);
    if (gen !== speechGen) return; // interrupted while synthesizing
    if (audio) send('audio:play', { data: audio.toString('base64'), rate: residualRate(ui.rate), gen });
    else setSayEndHandler(() => { if (gen === speechGen) setUi({ status: 'idle' }); });
  } catch (e) {
    log('system', `Speech failed: ${(e as Error).message}`);
    setUi({ status: 'idle' });
  }
}

export function stopSpeech(bump = true) {
  if (bump) speechGen++;
  stopLocal();
  send('audio:stop', null);
}

export const repeatLast = () => speak(lastSpoken || 'Nothing to repeat.');
