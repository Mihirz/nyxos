// Speech in and out. Cartesia is the default for both directions (lowest latency);
// ElevenLabs is a drop-in alternative; macOS `say` is the offline fallback.

import { spawn, type ChildProcess } from 'node:child_process';
import { config, effectiveStt, effectiveTts } from './config';

const CARTESIA_VERSION = '2026-08-14';

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  const provider = effectiveStt();
  if (provider === 'none') throw new Error('No speech-to-text key set. Add CARTESIA_API_KEY or ELEVENLABS_API_KEY to .env, or type commands.');
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'wav';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `utterance.${ext}`);

  if (provider === 'cartesia') {
    form.append('model', 'ink-whisper');
    form.append('language', 'en');
    const res = await fetch('https://api.cartesia.ai/stt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.cartesiaKey}`, 'Cartesia-Version': CARTESIA_VERSION },
      body: form,
    });
    if (!res.ok) throw new Error(`Cartesia STT ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { text: string }).text.trim();
  }

  form.append('model_id', 'scribe_v2');
  form.append('language_code', 'en');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenKey },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { text: string }).text.trim();
}

/** Returns mp3 bytes, or null when the `say` fallback played it directly. */
export async function synthesize(text: string, rate: number): Promise<Buffer | null> {
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
    if (!res.ok) throw new Error(`Cartesia TTS ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (provider === 'elevenlabs') {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.elevenVoice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: config.elevenTtsModel, voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)) } }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
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
