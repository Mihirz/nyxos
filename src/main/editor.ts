// Editor control. Prefers the VS Code bridge extension (exact lines, diagnostics);
// falls back to the accessibility API + keyboard for any other text app.

import { config } from './config';
import { axFocused, axFront } from './native';
import { pressKeys, typeText } from './system';

export interface EditorState {
  file: string | null;
  relPath?: string;
  languageId?: string;
  line?: number;
  column?: number;
  lineCount?: number;
  lineText?: string;
  selectedText?: string;
  dirty?: boolean;
  diagnostics?: { errors: number; warnings: number };
}

export interface BridgeEvent { seq: number; type: 'edit' | 'diagnostics' | 'file'; line?: number; text?: string; newline?: boolean; errors?: number; warnings?: number; relPath?: string }

// One bridge per VS Code window, on consecutive ports. Use the focused window's.
let activePort: number | null = null;
let portCheckedAt = 0;

async function discover(): Promise<number | null> {
  if (activePort && Date.now() - portCheckedAt < 1500) return activePort;
  const ports = Array.from({ length: 10 }, (_, i) => config.editorBridgePort + i);
  const states = await Promise.all(ports.map(async (p) => {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/state`, { signal: AbortSignal.timeout(400) });
      return { p, s: (await r.json()) as { focused?: boolean } };
    } catch { return null; }
  }));
  const live = states.filter((x): x is { p: number; s: { focused?: boolean } } => x != null);
  activePort = (live.find((x) => x.s.focused) ?? live[0])?.p ?? null;
  portCheckedAt = Date.now();
  return activePort;
}

async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const port = await discover();
  if (!port) throw new Error('Editor bridge not running. Run npm run bridge:install and reload VS Code.');
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(1500),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `bridge ${res.status}`);
  return json;
}

const EDITOR_APPS = /^(Code|Visual Studio Code|Cursor|Windsurf|VSCodium)$/;

/** True when the frontmost app is a VS Code-family editor with the bridge running. */
export async function bridgeActive(): Promise<boolean> {
  try {
    const front = await axFront();
    if (!EDITOR_APPS.test(front.app)) return false;
    portCheckedAt = 0; // re-pick the focused window
    const s = await call<{ focused?: boolean }>('GET', '/state');
    return s.focused !== false;
  } catch {
    return false;
  }
}

export const bridge = {
  state: () => call<EditorState>('GET', '/state'),
  goto: (line: number, column?: number) => call<EditorState>('POST', '/goto', { line, column }),
  lines: (from: number, to: number) => call<Array<{ n: number; text: string }>>('GET', `/lines?from=${from}&to=${to}`),
  insert: (text: string) => call<EditorState>('POST', '/insert', { text }),
  replaceLine: (line: number, text: string) => call<EditorState>('POST', '/replaceLine', { line, text }),
  diagnostics: () => call<Array<{ line: number; severity: string; message: string }>>('GET', '/diagnostics'),
  open: (query: string) => call<EditorState>('POST', '/open', { query }),
  save: () => call<EditorState>('POST', '/save'),
  command: (id: string, args?: unknown[]) => call<EditorState>('POST', '/command', { id, args }),
  events: (since: number) => call<{ seq: number; events: BridgeEvent[] }>('GET', `/events?since=${since}`),
};

// Per-app "go to line" shortcuts for the keyboard fallback.
const GOTO_LINE_KEYS: Record<string, string> = {
  Xcode: 'cmd+l', 'Sublime Text': 'ctrl+g', Zed: 'ctrl+g', 'IntelliJ IDEA': 'cmd+l', PyCharm: 'cmd+l', WebStorm: 'cmd+l',
  Code: 'ctrl+g', 'Visual Studio Code': 'ctrl+g', Cursor: 'ctrl+g', BBEdit: 'cmd+j', Nova: 'cmd+l',
};

export async function goToLine(line: number): Promise<{ text: string; via: 'bridge' | 'keys' }> {
  if (await bridgeActive()) {
    const s = await bridge.goto(line);
    return { text: s.lineText ?? '', via: 'bridge' };
  }
  const front = await axFront();
  const keys = GOTO_LINE_KEYS[front.app];
  if (!keys) throw new Error(`I don't know how to jump to a line in ${front.app}`);
  await pressKeys(keys);
  await new Promise((r) => setTimeout(r, 150));
  await typeText(String(line));
  await pressKeys('return');
  await new Promise((r) => setTimeout(r, 120));
  return { text: (await currentLineViaAx())?.text ?? '', via: 'keys' };
}

/** Line under the caret from the focused AX text element. */
export async function currentLineViaAx(): Promise<{ text: string; index: number; all: string[] } | null> {
  const f = await axFocused();
  if (f.value == null || !f.selection) return null;
  const before = f.value.slice(0, f.selection.location);
  const index = before.split('\n').length - 1;
  const all = f.value.split('\n');
  return { text: all[index] ?? '', index, all };
}

export async function readLines(count = 1): Promise<string> {
  if (await bridgeActive()) {
    const s = await bridge.state();
    if (!s.line) return 'No file open.';
    if (count <= 1) return speakLine(s.line, s.lineText ?? '');
    const ls = await bridge.lines(s.line, s.line + count - 1);
    return ls.map((l) => speakLine(l.n, l.text)).join('. ');
  }
  const cur = await currentLineViaAx();
  if (!cur) return 'Nothing readable is focused.';
  return cur.all.slice(cur.index, cur.index + Math.max(1, count)).map((t) => t.trim() || 'blank').join('. ');
}

export function speakLine(n: number, text: string): string {
  const t = text.trim();
  return `line ${n}${t ? `: ${t}` : ', blank'}`;
}

export async function insertText(text: string): Promise<'bridge' | 'keys'> {
  if (await bridgeActive()) {
    await bridge.insert(text);
    return 'bridge';
  }
  await typeText(text);
  return 'keys';
}
