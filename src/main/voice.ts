// Speech in and out. Cartesia is the default for both directions (lowest latency);
// ElevenLabs is a drop-in alternative; macOS `say` is the offline fallback.

import { spawn, type ChildProcess } from 'node:child_process';
import { config, effectiveStt, effectiveTts, exhausted, isQuotaError } from './config';

/** Told once when a provider runs out, so the user knows why the voice changed. */
let onProviderLost: ((name: string, now: string) => void) | null = null;
export const setProviderLostHandler = (fn: (name: string, now: string) => void) => { onProviderLost = fn; };
function lose(name: 'cartesia' | 'elevenlabs', kind: 'tts' | 'stt') {
  if (exhausted.has(name)) return;
  exhausted.add(name);
  onProviderLost?.(name, kind === 'tts' ? effectiveTts() : effectiveStt());
}

const CARTESIA_VERSION = '2026-08-14';

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  const provider = effectiveStt();
  if (provider === 'none') throw new Error('No speech-to-text key set. Add CARTESIA_API_KEY or ELEVENLABS_API_KEY to .env, or type commands.');
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'wav';
  const form = new FormData();
  // Plain container type: some STT endpoints reject "audio/webm;codecs=opus".
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] }), `utterance.${ext}`);

  if (provider === 'cartesia') {
    form.append('model', 'ink-whisper');
    form.append('language', 'en');
    const post = () => fetch('https://api.cartesia.ai/stt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.cartesiaKey}`, 'Cartesia-Version': CARTESIA_VERSION },
      body: form,
    });
    let res = await post();
    if (res.status === 400) res = await post(); // a clipped recording; one retry, then give up quietly
    if (res.status === 400) throw new Error("Didn't catch that.");
    if (!res.ok) {
      const body = await res.text();
      if (isQuotaError(res.status, body)) { lose('cartesia', 'stt'); if (effectiveStt() !== 'none') return transcribe(audio, mime); throw new Error('Speech-to-text is out of credits. Add a key, or type commands.'); }
      throw new Error(`Cartesia STT ${res.status}: ${body}`);
    }
    return ((await res.json()) as { text: string }).text.trim();
  }

  form.append('model_id', 'scribe_v2');
  form.append('language_code', 'en');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenKey },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    if (isQuotaError(res.status, body)) { lose('elevenlabs', 'stt'); if (effectiveStt() !== 'none') return transcribe(audio, mime); throw new Error('Speech-to-text is out of credits. Add a key, or type commands.'); }
    throw new Error(`ElevenLabs STT ${res.status}: ${body}`);
  }
  return ((await res.json()) as { text: string }).text.trim();
}

const ttsCache = new Map<string, Promise<Buffer | null>>();

/**
 * Cached speech: the same words at the same speed are synthesized once ("Still working.",
 * "Selected Comic.", repeated menus), so repeats start playing with no network wait.
 */
export function synthesizeCached(text: string, rate: number): Promise<Buffer | null> {
  if (effectiveTts() === 'say') return synthesize(text, rate);
  const key = `${effectiveTts()}|${rate}|${text}`;
  const hit = ttsCache.get(key);
  if (hit) { ttsCache.delete(key); ttsCache.set(key, hit); return hit; }
  const p = synthesize(text, rate).catch((e) => { ttsCache.delete(key); throw e; });
  ttsCache.set(key, p);
  if (ttsCache.size > 400) ttsCache.delete(ttsCache.keys().next().value!);
  return p;
}

/** Returns mp3 bytes, or null when the `say` fallback played it directly. */
export async function synthesize(text: string, rate: number, attempt = 0): Promise<Buffer | null> {
  const provider = effectiveTts();
  if (provider === 'cartesia') {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.cartesiaKey}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: config.cartesiaModel,
        transcript: text,
        voice: { id: config.cartesiaVoice },
        language: 'en',
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
        // Cartesia caps native speed at 1.5x; the renderer stacks playbackRate on top
        // because experienced screen reader users listen at 2-3x.
        generation_config: { speed: Math.min(1.5, Math.max(0.6, rate)) },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (isQuotaError(res.status, body)) { lose('cartesia', 'tts'); return synthesize(text, rate); }
      // Too many requests at once (streamed sentences, warm-up): wait a moment and retry.
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); return synthesize(text, rate, attempt + 1); }
      throw new Error(`Cartesia TTS ${res.status}: ${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  if (provider === 'elevenlabs') {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.elevenVoice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: config.elevenTtsModel, voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)) } }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (isQuotaError(res.status, body)) { lose('elevenlabs', 'tts'); return synthesize(text, rate); }
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); return synthesize(text, rate, attempt + 1); }
      throw new Error(`ElevenLabs TTS ${res.status}: ${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  // `say` plays directly; don't block the caller until speech ends.
  sayLocal(text, rate).then(() => onSayEnd?.());
  return null;
}

let onSayEnd: (() => void) | null = null;
export const setSayEndHandler = (fn: () => void) => { onSayEnd = fn; };

/** How much speed the renderer must add via playbackRate beyond what the provider applied. */
export function residualRate(rate: number): number {
  const p = effectiveTts();
  const applied = p === 'cartesia' ? Math.min(1.5, Math.max(0.6, rate)) : p === 'elevenlabs' ? Math.min(1.2, Math.max(0.7, rate)) : rate;
  return rate / applied;
}

let sayProc: ChildProcess | null = null;

function sayLocal(text: string, rate: number): Promise<void> {
  stopLocal();
  return new Promise((resolve) => {
    sayProc = spawn('say', ['-r', String(Math.round(190 * rate)), text]);
    sayProc.on('exit', () => resolve());
    sayProc.on('error', () => resolve());
  });
}

export function stopLocal() {
  if (sayProc && !sayProc.killed) sayProc.kill();
  sayProc = null;
}
