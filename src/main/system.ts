// System-level hands: launching apps, typing, pressing keys.

import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipboard } from 'electron';
import { osascript, shell, axWindows, type WindowInfo } from './native';

const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];

const ALIASES: Record<string, string> = {
  code: 'Visual Studio Code', 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', 'visual studio': 'Visual Studio Code',
  editor: 'Visual Studio Code', chrome: 'Google Chrome', browser: 'Safari', terminal: 'Terminal', term: 'Terminal',
  messages: 'Messages', imessage: 'Messages', texts: 'Messages', mail: 'Mail', email: 'Mail', notes: 'Notes',
  finder: 'Finder', files: 'Finder', settings: 'System Settings', preferences: 'System Settings',
  music: 'Music', spotify: 'Spotify', slack: 'Slack', discord: 'Discord', calendar: 'Calendar', zoom: 'zoom.us',
};

let appCache: string[] | null = null;
export function installedApps(): string[] {
  if (appCache) return appCache;
  const names = new Set<string>();
  for (const dir of APP_DIRS) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.app')) names.add(f.slice(0, -4));
    } catch { /* dir missing */ }
  }
  return (appCache = [...names]);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Best fuzzy match of a spoken name against candidates. */
export function fuzzyPick<T>(query: string, items: T[], key: (t: T) => string): T | null {
  const q = norm(query);
  if (!q) return null;
  let best: T | null = null, bestScore = 0;
  for (const it of items) {
    const k = norm(key(it));
    if (!k) continue;
    let score = 0;
    if (k === q) score = 100;
    else if (k.startsWith(q)) score = 80;
    else if (k.split(' ').some((w) => w.startsWith(q))) score = 70;
    else if (k.includes(q)) score = 60;
    else {
      const qw = q.split(' ');
      const hits = qw.filter((w) => k.includes(w)).length;
      if (hits) score = 40 * (hits / qw.length);
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 30 ? best : null;
}

export function resolveApp(spoken: string): string | null {
  const alias = ALIASES[norm(spoken)];
  if (alias) return alias;
  return fuzzyPick(spoken, installedApps(), (a) => a);
}

/** Prefer switching to an existing window over launching. Returns a description of what happened. */
export async function openApp(spoken: string): Promise<{ ok: boolean; name: string; window?: WindowInfo }> {
  const name = resolveApp(spoken);
  const wins = await axWindows().catch(() => [] as WindowInfo[]);
  const running = fuzzyPick(name ?? spoken, wins, (w) => w.app);
  if (running && (!name || norm(running.app) === norm(name))) {
    await shell('open', ['-a', running.app]).catch(() => undefined);
    return { ok: true, name: running.app, window: running };
  }
  if (!name) return { ok: false, name: spoken };
  await shell('open', ['-a', name]);
  return { ok: true, name };
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Type text into whatever has focus. Short plain strings use real keystrokes;
 * long or multi-line text goes through the clipboard (much faster, no dropped
 * characters, no auto-indent mangling) and the user's clipboard is restored.
 */
export async function typeText(text: string): Promise<void> {
  if (text.length <= 40 && !/[\n\t]/.test(text)) {
    await osascript(`tell application "System Events" to keystroke "${esc(text)}"`);
    return;
  }
  const saved = await clipboard.readText();
  await clipboard.writeText(text);
  await pressKeys('cmd+v');
  setTimeout(() => clipboard.writeText(saved), 400);
}

const KEY_CODES: Record<string, number> = {
  return: 36, tab: 48, space: 49, delete: 51, escape: 53, forwarddelete: 117, home: 115, end: 119,
  pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODS: Record<string, string> = { cmd: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' };

/** "cmd+shift+p" → System Events keystroke. */
export async function pressKeys(combo: string): Promise<void> {
  const parts = combo.toLowerCase().split('+').filter(Boolean);
  const mods = parts.filter((p) => MODS[p]).map((p) => MODS[p]);
  const keys = parts.filter((p) => !MODS[p]);
  const key = keys[keys.length - 1] ?? '';
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const action = KEY_CODES[key] != null ? `key code ${KEY_CODES[key]}` : `keystroke "${esc(key)}"`;
  await osascript(`tell application "System Events" to ${action}${using}`);
}

export function spokenKeys(combo: string): string {
  const names: Record<string, string> = { cmd: 'command', ctrl: 'control', alt: 'option', return: 'enter' };
  return combo.split('+').map((k) => names[k] ?? k).join(' ');
}
