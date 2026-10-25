// Single output funnel: every word nyxOS says goes through speak(), which
// drives TTS, the braille pipeline, and the on-screen transcript together.

import type { BrowserWindow } from 'electron';
import { brailleLines } from '../core/braille';
import type { LogEntry, UiState } from '../shared/types';
import { effectiveTts } from './config';
import { synthesizeCached, residualRate, setSayEndHandler, stopLocal } from './voice';

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
  follow: true, view: 'home', providers: { claude: false, gemini: false, tts: 'say', stt: 'none' }, verbosity: 'normal', discreet: false,
};

export function setUi(patch: Partial<UiState>) {
  Object.assign(ui, patch);
  send('ui', ui);
}

export function log(who: LogEntry['who'], text: string, via?: LogEntry['via'], ms?: number) {
  if (process.env.NYX_SCRIPT) console.log(`[${who}${via ? ' ' + via : ''}${ms != null ? ' ' + ms + 'ms' : ''}] ${text}`);
  send('log', { id: ++logId, at: Date.now(), who, text, via, ms } satisfies LogEntry);
}

/**
 * Braille driver interface. The display shows a condensed form of what's on screen (the page,
 * its options), not the last spoken reply. The virtual display lays out lines itself; hardware
 * drivers get the first 40-cell line and pan with their own keys.
 */
export interface BrailleDriver { name: string; write(text: string, firstLine: string): void }
const drivers: BrailleDriver[] = [{ name: 'virtual', write: (text) => send('braille', text) }];
export const addBrailleDriver = (d: BrailleDriver) => drivers.push(d);
let brailleNow = '';

export function setBraille(text: string) {
  if (!text || text === brailleNow) return;
  brailleNow = text;
  const first = brailleLines(text)[0]?.braille ?? '';
  for (const d of drivers) d.write(text, first);
}

/** When the user last pressed the talk key or Esc: older speech must not start after it. */
let interruptedAt = 0;

/** What is being spoken right now, and when it started (for "macOS say", which reports no progress). */
let playing: { text: string; at: number; estimated: boolean } | null = null;
/** Playback finished on its own: nothing is "being heard" any more. */
export const speechEnded = () => { playing = null; };
export interface Heard { text: string; pos: number; at: number }
let heardHandler: ((h: Heard) => void) | null = null;
export const onInterrupted = (fn: (h: Heard) => void) => { heardHandler = fn; };

/** The user cut in: work out how much of the sentence they had heard. */
export function noteInterrupt(fraction: number | null, seg = 0, len?: number) {
  if (!playing || (fraction == null && !playing.estimated)) return;
  const { text, at } = playing;
  playing = null;
  // Audio reports how far through the playing sentence it was; for "say", estimate from
  // elapsed time (~15 characters a second at 1x).
  const pos = fraction != null ? Math.round(seg + fraction * (len ?? text.length - seg)) : Math.min(text.length, Math.round(((Date.now() - at) / 1000) * 15 * ui.rate));
  heardHandler?.({ text, pos, at: Date.now() });
}

export async function speak(text: string, opts: { via?: LogEntry['via']; ms?: number; quiet?: boolean; startedAt?: number } = {}) {
  if (!text) return;
  // While the user is talking, or for anything begun before they interrupted, show it but stay silent.
  // Silent only while the user is holding the talk key, or for a reply begun before they cut in.
  // ("Transcribing" means they've finished talking: replies to what they said must be heard.)
  const silent = ui.status === 'listening' || (opts.startedAt != null && opts.startedAt < interruptedAt);
  if (silent) opts = { ...opts, quiet: true };
  lastSpoken = text;
  const gen = ++speechGen;
  log('nyx', text, opts.via, opts.ms);
  // NYX_MUTE: transcript and braille only (scripted test runs shouldn't talk out loud).
  // Muted test runs still model playback timing, so interruptions can be tested without sound.
  if (process.env.NYX_MUTE && !opts.quiet) playing = { text, at: Date.now(), estimated: true };
  if (opts.quiet || process.env.NYX_MUTE) return;
  stopSpeech(false);
  setUi({ status: 'speaking' });
  try {
    // ALL-CAPS words (game tiles, banners) are read as words, not spelled out; short acronyms stay.
    const audio = await synthesizeCached(forSpeech(text), ui.rate);
    if (gen !== speechGen) return; // interrupted while synthesizing
    if (audio) { playing = { text, at: Date.now(), estimated: false }; send('audio:play', { data: audio.toString('base64'), rate: residualRate(ui.rate), gen, seg: 0, len: text.length }); }
    else { playing = { text, at: Date.now(), estimated: true }; setSayEndHandler(() => { if (gen === speechGen) { playing = null; setUi({ status: 'idle' }); } }); }
  } catch (e) {
    log('system', `Speech failed: ${(e as Error).message}`);
    setUi({ status: 'idle' });
  }
}

let interruptedBefore = 0;

/** The talk key turned out to hold no words: don't silence replies that were on their way. */
export function cancelInterrupt() { interruptedAt = interruptedBefore; }

export function stopSpeech(bump = true) {
  if (bump) { speechGen++; interruptedBefore = interruptedAt; interruptedAt = Date.now(); }
  stopLocal();
  send('audio:stop', null);
}

export const repeatLast = () => speak(lastSpoken || 'Nothing to repeat.');

// ALL-CAPS words (game tiles, banners) are read as words, not spelled out; short acronyms stay.
const forSpeech = (t: string) => t.replace(/\b[A-Z][A-Z'-]{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());

/**
 * Streamed speech: Claude's reply is spoken sentence by sentence as it is written, so the
 * first words play about a second sooner. Sentences synthesize in parallel and play in order.
 */
let stream: { gen: number; text: string; chain: Promise<void>; sent: number } | null = null;

export function speakStreamStart(): number {
  stopSpeech(false);
  const gen = ++speechGen;
  stream = { gen, text: '', chain: Promise.resolve(), sent: 0 };
  return gen;
}

export function speakStreamPart(gen: number, sentence: string) {
  const s = stream;
  if (!s || s.gen !== gen || gen !== speechGen || !sentence.trim()) return;
  const seg = s.text ? s.text.length + 1 : 0;
  s.text = s.text ? `${s.text} ${sentence}` : sentence;
  const silent = ui.status === 'listening';
  if (silent || process.env.NYX_MUTE || effectiveTts() === 'say') return; // spoken whole at the end instead
  const audio = synthesizeCached(forSpeech(sentence), ui.rate);
  s.chain = s.chain.then(async () => {
    const a = await audio.catch(() => null);
    if (!a || gen !== speechGen) return;
    s.sent++;
    playing = { text: s.text, at: Date.now(), estimated: false };
    setUi({ status: 'speaking' });
    send('audio:play', { data: a.toString('base64'), rate: residualRate(ui.rate), gen, queue: true, seg, len: sentence.length });
  });
}

/** The reply is complete: put it in the transcript; speak it whole if nothing could be streamed. */
export async function speakStreamEnd(gen: number, full: string, opts: { via?: LogEntry['via']; ms?: number; startedAt?: number } = {}) {
  const s = stream;
  if (!s || s.gen !== gen) return speak(full, opts);
  await s.chain;
  stream = null;
  if (s.sent === 0) return speak(full, opts);
  lastSpoken = full;
  log('nyx', full, opts.via, opts.ms);
}
