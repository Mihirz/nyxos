import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

loadEnv({ path: path.join(app.getAppPath(), '.env'), quiet: true } as never);

const env = (k: string, d = '') => process.env[k]?.trim() || d;

export const config = {
  anthropicKey: env('ANTHROPIC_API_KEY'),
  // Haiku answers first and escalates to the strong model when a request needs it.
  claudeFastModel: env('CLAUDE_FAST_MODEL', 'claude-haiku-5-5'),
  claudeModel: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  claudeEffort: env('CLAUDE_EFFORT', 'low') as 'low' | 'medium' | 'high',
  geminiKey: env('GEMINI_API_KEY'),
  geminiModel: env('GEMINI_MODEL', 'gemini-flash-latest'),
  cartesiaKey: env('CARTESIA_API_KEY'),
  cartesiaVoice: env('CARTESIA_VOICE_ID', 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'),
  cartesiaModel: env('CARTESIA_MODEL', 'sonic-3.6'),
  elevenKey: env('ELEVENLABS_API_KEY'),
  elevenVoice: env('ELEVENLABS_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb'),
  elevenTtsModel: env('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
  ttsProvider: env('TTS_PROVIDER', 'cartesia') as 'cartesia' | 'elevenlabs' | 'say',
  sttProvider: env('STT_PROVIDER', 'cartesia') as 'cartesia' | 'elevenlabs',
  hotkeyListen: env('HOTKEY_LISTEN', 'Alt+Space'),
  hotkeyCommand: env('HOTKEY_COMMAND', 'Alt+Shift+Space'),
  editorBridgePort: Number(env('EDITOR_BRIDGE_PORT', '47100')),
};

export type VoiceProvider = 'cartesia' | 'elevenlabs';

/** Providers that failed for credits or keys this session: skipped until switched to again. */
export const exhausted = new Set<string>();

/** Switch speaking and listening to a provider, and remember it in .env for the next launch. */
export function setVoiceProvider(p: VoiceProvider): boolean {
  if (p === 'cartesia' ? !config.cartesiaKey : !config.elevenKey) return false;
  config.ttsProvider = p;
  config.sttProvider = p;
  exhausted.delete(p);
  try {
    const file = path.join(app.getAppPath(), '.env');
    let s = readFileSync(file, 'utf8');
    for (const [k, v] of [['TTS_PROVIDER', p], ['STT_PROVIDER', p]]) s = new RegExp(`^${k}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${s}\n${k}=${v}`;
    writeFileSync(file, s);
  } catch { /* remembered for this session only */ }
  return true;
}

/** Resolve the provider actually usable given which keys exist. */
const usable = (p: string) => !exhausted.has(p) && (p === 'cartesia' ? Boolean(config.cartesiaKey) : p === 'elevenlabs' ? Boolean(config.elevenKey) : false);

export function effectiveTts(): 'cartesia' | 'elevenlabs' | 'say' {
  if (config.ttsProvider === 'say') return 'say';
  if (usable(config.ttsProvider)) return config.ttsProvider as VoiceProvider;
  if (usable('cartesia')) return 'cartesia';
  if (usable('elevenlabs')) return 'elevenlabs';
  return 'say';
}

export function effectiveStt(): 'cartesia' | 'elevenlabs' | 'none' {
  if (usable(config.sttProvider)) return config.sttProvider;
  if (usable('cartesia')) return 'cartesia';
  if (usable('elevenlabs')) return 'elevenlabs';
  return 'none';
}

/**
 * A credit/key failure (switch provider): 401 unauthorized, 402 payment required, or a 429 that
 * says credits/quota/balance. A 429 for too many requests at once is not: that just retries.
 */
export const isQuotaError = (status: number, body: string) => status === 401 || status === 402 || (status === 429 && /credit|quota|insufficient|balance|payment|billing/i.test(body));
