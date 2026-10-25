// Eyes. When the accessibility tree is thin (canvas apps, games, images, many
// Electron apps), we screenshot and have a vision model transcribe the UI into
// structured text. Gemini is the default (fast + cheap for dense screenshots);
// Claude is the fallback so the feature works with a single key.

import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { shell } from './native';

const PROMPT = `You are the eyes of a blind computer user. Transcribe this screenshot into plain text a screen reader can use.
Structure it hierarchically:
1. WINDOW: app name and window title.
2. REGIONS: each major area (toolbar, sidebar, tabs, main content, dialogs, notifications) in visual reading order, top-left to bottom-right.
3. Inside each region: every readable text, button, link, field (with its current value), checkbox state, selected item, and any error or badge.
Mark anything that looks focused or selected with [FOCUSED]. Do not describe colors or styling unless they carry meaning (red error, disabled).
Be literal and complete; do not summarize away text. No markdown tables.`;

async function screenshot(): Promise<string> {
  const file = path.join(os.tmpdir(), `nyx-${Date.now()}.jpg`);
  await shell('screencapture', ['-x', '-t', 'jpg', file]);
  // Downscale: faster upload, and vision models don't need retina pixels.
  await shell('sips', ['-Z', '1800', file]).catch(() => undefined);
  const data = (await readFile(file)).toString('base64');
  rm(file).catch(() => undefined);
  return data;
}

export async function describeScreen(): Promise<{ text: string; via: 'gemini' | 'claude' }> {
  const data = await screenshot();
  if (config.geminiKey) {
    const ai = new GoogleGenAI({ apiKey: config.geminiKey });
    const res = await ai.models.generateContent({
      model: config.geminiModel,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data } }, { text: PROMPT }] }],
    });
    return { text: res.text ?? '', via: 'gemini' };
  }
  if (config.anthropicKey) {
    const client = new Anthropic({ apiKey: config.anthropicKey });
    const res = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }, { type: 'text', text: PROMPT }] }],
    });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    return { text, via: 'claude' };
  }
  throw new Error('No vision model configured. Add GEMINI_API_KEY or ANTHROPIC_API_KEY.');
}
