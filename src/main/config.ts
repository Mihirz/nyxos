import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { app } from 'electron';

loadEnv({ path: path.join(app.getAppPath(), '.env'), quiet: true } as never);

const env = (k: string, d = '') => process.env[k]?.trim() || d;

export const config = {
  anthropicKey: env('ANTHROPIC_API_KEY'),
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

/** Resolve the provider actually usable given which keys exist. */
export function effectiveTts(): 'cartesia' | 'elevenlabs' | 'say' {
  if (config.ttsProvider === 'cartesia' && config.cartesiaKey) return 'cartesia';
  if (config.ttsProvider === 'elevenlabs' && config.elevenKey) return 'elevenlabs';
  if (config.ttsProvider !== 'say') {
    if (config.cartesiaKey) return 'cartesia';
    if (config.elevenKey) return 'elevenlabs';
  }
  return 'say';
}

export function effectiveStt(): 'cartesia' | 'elevenlabs' | 'none' {
  if (config.sttProvider === 'cartesia' && config.cartesiaKey) return 'cartesia';
  if (config.sttProvider === 'elevenlabs' && config.elevenKey) return 'elevenlabs';
  if (config.cartesiaKey) return 'cartesia';
  if (config.elevenKey) return 'elevenlabs';
  return 'none';
}
