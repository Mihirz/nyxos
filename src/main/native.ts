// Thin wrappers around the Swift AX helper and osascript.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString());
    });
  });
}

const helperPath = () => path.join(app.getAppPath(), 'dist', 'bin', 'axhelper');

async function ax<T>(...args: string[]): Promise<T> {
  const raw = await run(helperPath(), args).catch((e) => {
    // The helper prints {"error": ...} and exits 1 on failure; surface that message.
    const m = /\{"error":"([^"]+)"\}/.exec(String(e.message));
    throw new Error(m ? m[1] : e.message);
  });
  return JSON.parse(raw) as T;
}

export interface WindowInfo { app: string; pid: number; index: number; title: string; minimized: boolean; frontmost: boolean }
export interface FrontInfo { app: string; bundleId: string; pid: number; title: string }
export interface AxNode { path: string; role: string; label?: string; value?: string; subrole?: string; actionable?: boolean; focused?: boolean; children?: AxNode[] }
export interface FocusedInfo { role: string | null; label?: string; value?: string; selection?: { location: number; length: number }; line?: number; selectedText?: string }

export const axTrusted = (prompt = false) => ax<{ trusted: boolean }>('trusted', ...(prompt ? ['prompt'] : [])).then((r) => r.trusted);
export const axWindows = () => ax<{ windows: WindowInfo[] }>('windows').then((r) => r.windows);
export const axFocus = (pid: number, index = 0) => ax<{ ok: boolean }>('focus', String(pid), String(Math.max(index, 0)));
export const axFront = () => ax<FrontInfo>('front');
export const axTree = (depth = 25, nodes = 300) => ax<{ app: string; title: string; tree: AxNode[] }>('tree', String(depth), String(nodes));
export const axFocused = () => ax<FocusedInfo>('focused');
export const axPress = (p: string) => ax<{ ok: boolean }>('press', p);

export function osascript(script: string, lang: 'AppleScript' | 'JavaScript' = 'AppleScript', timeout = 6000) {
  return run('osascript', ['-l', lang, '-e', script], timeout).then((s) => s.trim());
}

export const shell = run;

/** Render an AX tree as compact indented text for an LLM (paths let it reference elements). */
export function treeToText(nodes: AxNode[], depth = 0, lines: string[] = [], maxChars = 9000): string {
  for (const n of nodes) {
    if (lines.join('\n').length > maxChars) break;
    const bits = [n.role.replace(/^AX/, '')];
    if (n.label) bits.push(`"${n.label}"`);
    if (n.value) bits.push(`= ${JSON.stringify(n.value)}`);
    if (n.focused) bits.push('[FOCUSED]');
    lines.push(`${'  '.repeat(depth)}${bits.join(' ')} {${n.path}}`);
    if (n.children) treeToText(n.children, depth + 1, lines, maxChars);
  }
  return lines.join('\n');
}

export function countNodes(nodes: AxNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + (n.children ? countNodes(n.children) : 0), 0);
}
