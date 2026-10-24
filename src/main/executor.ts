// The dispatcher. Every input (voice, typed shortcode, Claude tool call) becomes a
// Command and runs through handle(). Navigation is hierarchical:
//
//   system  — which window/app am I in?            ("windows", "3")
//   app     — which region of this app?            ("read screen", "click save")
//   content — which line/item inside the region?   ("go to line 42", "next")
//   web     — Lens page regions → items             ("outline", "links", "2")
//
// "back" walks up a level; numbers pick from whatever list was last spoken.

import type { BrowserWindow } from 'electron';
import { parseCommand, SHORTCODES, type Command, type Source } from '../core/commands';
import { speakOptions, MAX_SPOKEN_OPTIONS, type OptionItem } from '../core/narration';
import type { LensItem, LensPage } from '../shared/types';
import { claudeAvailable, narrateScreen, operator, spokenToCode, summarizeUnread } from './claude';
import { setCurtain } from './curtain';
import { bridge, bridgeActive, goToLine, insertText, readLines, speakLine } from './editor';
import { contactName, digest, sendMessage, unreadMessages } from './messages';
import { axFocus, axFocused, axFront, axPress, axTree, axWindows, countNodes, treeToText, type AxNode, type FrontInfo, type WindowInfo } from './native';
import { log, repeatLast, setUi, speak, stopSpeech, ui } from './output';
import { rpc } from './rpc';
import { fuzzyPick, openApp, pressKeys, spokenKeys } from './system';
import { describeScreen } from './vision';
import { fetchPage, looksLikeUrl, normalizeUrl, searchUrl } from './web';

type Action =
  | { t: 'window'; w: WindowInfo }
  | { t: 'ax'; path: string; label: string }
  | { t: 'lens'; item: LensItem }
  | { t: 'region'; item: LensItem }
  | { t: 'thread'; handle: string; name: string; text: string }
  | { t: 'say'; text: string };

interface Reply { speak: string; via?: 'grammar' | 'claude' | 'gemini'; quiet?: boolean }

interface Menu { title: string; level: string; items: OptionItem<Action>[]; offset: number }

const state = {
  menu: null as Menu | null,
  stack: [] as Menu[],
  lensActive: false,
  lensPage: null as LensPage | null,
  pendingInput: null as LensItem | null,
  article: [] as string[],
  articleAt: 0,
  replyTo: null as { handle: string; name: string } | null,
  prevFront: null as FrontInfo | null,
  recent: [] as string[],
  suppressFollowUntil: 0,
};

let mainWin: BrowserWindow | null = null;
export function attachExecutorWindow(w: BrowserWindow) {
  mainWin = w;
}

// ------------------------------------------------------------------ entry point

export async function runText(text: string, source: Source): Promise<void> {
  const started = Date.now();
  log('user', text, source);
  const cmd = parseCommand(text, source) ?? { kind: 'ask', text };
  remember(`user: ${text}`);
  try {
    const reply = await handle(cmd);
    remember(`callbacks: ${reply.speak}`);
    await speak(reply.speak, { via: reply.via ?? (cmd.kind === 'ask' ? 'claude' : 'grammar'), ms: Date.now() - started, quiet: reply.quiet });
  } catch (e) {
    await speak(friendlyError(e), { via: 'grammar', ms: Date.now() - started });
  } finally {
    if (ui.status === 'thinking') setUi({ status: 'idle' });
  }
}

function remember(line: string) {
  state.recent.push(line);
  if (state.recent.length > 12) state.recent.shift();
}

function friendlyError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/not trusted|AXError|assistive/i.test(m)) return 'I need Accessibility permission. Open System Settings, Privacy and Security, Accessibility, and allow Callbacks.';
  if (/ECONNREFUSED|fetch failed/i.test(m)) return 'Network request failed.';
  return m.length > 220 ? m.slice(0, 220) : m;
}

// ------------------------------------------------------------------ menus

function showMenu(title: string, level: string, items: OptionItem<Action>[], push = true): string {
  if (push && state.menu) state.stack.push(state.menu);
  state.menu = { title, level, items, offset: 0 };
  setUi({ level, options: items.map(({ label, detail }) => ({ label, detail })), optionsTitle: title });
  return speakOptions(title, items);
}

function clearMenu(level: string) {
  state.menu = null;
  state.stack = [];
  setUi({ level, options: [], optionsTitle: '' });
}

// ------------------------------------------------------------------ main switch

export async function handle(cmd: Command): Promise<Reply> {
  switch (cmd.kind) {
    case 'stop': stopSpeech(); return { speak: '', quiet: true };
    case 'repeat': await repeatLast(); return { speak: '', quiet: true };
    case 'help': return { speak: helpText() };
    case 'rate': {
      const rate = Math.round(Math.min(3.5, Math.max(0.75, ui.rate + cmd.delta)) * 100) / 100;
      setUi({ rate });
      return { speak: `Speed ${rate}.` };
    }
    case 'curtain': setCurtain(cmd.on); setUi({ curtain: cmd.on }); return { speak: cmd.on ? 'Screen curtain on.' : 'Screen curtain off.' };
    case 'performance':
      setUi({ performance: cmd.on });
      return { speak: cmd.on ? 'Performance mode on. Web pages load as text only, no rendering.' : 'Performance mode off.' };
    case 'follow': setUi({ follow: cmd.on }); return { speak: cmd.on ? 'Follow mode on. I will read new lines as they appear.' : 'Follow mode off.' };

    case 'windows': return { speak: await listWindows() };
    case 'choose': return { speak: await choose(cmd.index) };
    case 'next': return { speak: await step(1) };
    case 'previous': return { speak: await step(-1) };
    case 'back': return { speak: await back() };
    case 'whereAmI': return { speak: await whereAmI() };

    case 'open': return { speak: await open(cmd.target) };
    case 'goToLine': {
      await toPrevApp();
      const r = await goToLine(cmd.line);
      setUi({ level: 'Content' });
      return { speak: speakLine(cmd.line, r.text) };
    }
    case 'readLine': return { speak: await readLines(cmd.count ?? 1) };
    case 'type': return { speak: await typeInto(cmd.text) };
    case 'code': return await dictateCode(cmd.spoken);
    case 'press': return { speak: await press(cmd.keys) };
    case 'click': return { speak: await click(cmd.target) };
    case 'scroll':
      if (state.lensActive) { await rpc('lens.scroll', { direction: cmd.direction }); return { speak: `Scrolled ${cmd.direction}.` }; }
      await toPrevApp();
      await pressKeys(cmd.direction === 'down' ? 'pagedown' : 'pageup');
      return { speak: `Page ${cmd.direction}.` };

    case 'readScreen': return await readScreen(cmd.goal);
    case 'search': return { speak: await lensGo(searchUrl(cmd.query), `Results for ${cmd.query}`) };
    case 'web': return { speak: await webView(cmd.view) };

    case 'unread': return await unread();
    case 'reply': return { speak: await reply(cmd.to, cmd.text) };

    case 'ask': return await ask(cmd.text);
  }
}

function helpText(): string {
  return 'Say windows to switch apps, open an app, go to line, type, press keys, read line, read screen, search, links, headings, unread messages, or reply. Numbers pick from any list. Back goes up a level. Type shortcodes like g 42 or o safari. Anything else, just ask.';
}

// ------------------------------------------------------------------ system level

async function listWindows(): Promise<string> {
  const wins = (await axWindows()).filter((w) => w.app !== 'Electron' && w.app !== 'Callbacks');
  const items: OptionItem<Action>[] = wins
    .sort((a, b) => Number(b.frontmost) - Number(a.frontmost))
    .map((w) => ({ label: w.app, detail: w.title && w.title !== w.app ? shortTitle(w.title) : undefined, action: { t: 'window', w } }));
  items.unshift({ label: 'Lens browser', detail: state.lensPage?.title, action: { t: 'say', text: '__lens' } });
  state.stack = [];
  state.menu = null;
  return showMenu('Windows', 'Windows', items, false);
}

const shortTitle = (t: string) => t.replace(/ [—–-] (Visual Studio Code|Google Chrome|Safari)$/, '').slice(0, 60);

async function focusWindow(w: WindowInfo): Promise<string> {
  state.lensActive = false;
  if (w.index < 0) await openApp(w.app);
  else await axFocus(w.pid, w.index);
  state.prevFront = { app: w.app, bundleId: '', pid: w.pid, title: w.title };
  clearMenu('App');
  let extra = '';
  if (await bridgeActive()) {
    const s = await bridge.state();
    if (s.line) extra = `, ${s.relPath}, ${speakLine(s.line, s.lineText ?? '')}`;
  }
  return `${w.app}${w.title && !extra ? `, ${shortTitle(w.title)}` : ''}${extra}.`;
}

/** If Callbacks itself has focus (typed command bar), hand focus back to the app the user was in. */
async function toPrevApp() {
  if (!mainWin?.isFocused() || state.lensActive) return;
  if (state.prevFront) {
    await axFocus(state.prevFront.pid, 0).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 180));
  }
}

export async function capturePrevFront() {
  try {
    const f = await axFront();
    if (f.app !== 'Electron' && f.app !== 'Callbacks') state.prevFront = f;
  } catch { /* no AX trust yet */ }
}

async function open(target: string): Promise<string> {
  const t = target.trim();
  if (/^(lens|the lens|browser|the browser|web|the web|callbacks)$/i.test(t)) return showLens();
  if (looksLikeUrl(t)) return lensGo(normalizeUrl(t));
  const fileMatch = t.match(/^(?:the )?file (.+)$/i);
  if (fileMatch && (await bridgeActive())) {
    const s = await bridge.open(fileMatch[1].replace(/\s+dot\s+/g, '.'));
    return `${s.relPath}, ${speakLine(s.line ?? 1, s.lineText ?? '')}`;
  }
  const r = await openApp(t);
  if (!r.ok) return `I couldn't find an app called ${t}. Say windows to hear what's open.`;
  state.lensActive = false;
  clearMenu('App');
  await new Promise((res) => setTimeout(res, 350));
  const front = await axFront().catch(() => null);
  if (front) state.prevFront = front;
  if (await bridgeActive()) {
    const s = await bridge.state();
    if (s.line) return `${r.name}, ${s.relPath}, ${speakLine(s.line, s.lineText ?? '')}`;
  }
  return `${r.name}${front?.title ? `, ${shortTitle(front.title)}` : ''}.`;
}

async function whereAmI(): Promise<string> {
  if (state.lensActive && state.lensPage) {
    const field = state.pendingInput ? ` Editing ${state.pendingInput.label}.` : '';
    return `Lens, ${state.lensPage.title}.${field} ${state.menu ? `In ${state.menu.title}.` : ''}`;
  }
  const front = await axFront();
  if (await bridgeActive()) {
    const s = await bridge.state();
    const d = s.diagnostics;
    const diag = d && (d.errors || d.warnings) ? ` ${d.errors} errors, ${d.warnings} warnings.` : '';
    return `${front.app}, ${s.relPath}, ${speakLine(s.line ?? 1, s.lineText ?? '')}.${s.dirty ? ' Unsaved.' : ''}${diag}`;
  }
  const f = await axFocused().catch(() => null);
  const focus = f?.role ? ` Focus: ${f.role.replace(/^AX/, '')}${f.label ? ` ${f.label}` : ''}.` : '';
  return `${front.app}${front.title ? `, ${shortTitle(front.title)}` : ''}.${focus}`;
}

// ------------------------------------------------------------------ choosing & stepping

async function choose(n: number): Promise<string> {
  const menu = state.menu;
  if (!menu) {
    if (state.lensActive && state.lensPage) return webView('outline').then(() => choose(n));
    return 'No list to choose from. Say windows, or read screen.';
  }
  const item = menu.items[n - 1];
  if (!item) return `There are only ${menu.items.length} options.`;
  return act(item.action, item.label);
}

async function act(a: Action, label: string): Promise<string> {
  switch (a.t) {
    case 'window': return focusWindow(a.w);
    case 'say': return a.text === '__lens' ? showLens() : a.text;
    case 'ax': {
      await toPrevApp();
      const r = await axPress(a.path);
      return r.ok ? `${label}.` : `Couldn't press ${label}.`;
    }
    case 'region': {
      const ids = new Set(a.item.children ?? []);
      const kids = (state.lensPage?.items ?? []).filter((i) => ids.has(i.id));
      return showMenu(a.item.label, 'Web', kids.map((k) => lensOption(k)));
    }
    case 'lens': return activateLens(a.item);
    case 'thread':
      state.replyTo = { handle: a.handle, name: a.name };
      return `${a.name}: ${a.text}. Say reply, then your message.`;
  }
}

async function step(dir: 1 | -1): Promise<string> {
  // Paging through a long spoken list.
  if (state.menu && state.menu.items.length > MAX_SPOKEN_OPTIONS) {
    const m = state.menu;
    m.offset = Math.max(0, Math.min(m.items.length - 1, m.offset + dir * MAX_SPOKEN_OPTIONS));
    return speakOptions(m.title, m.items, m.offset);
  }
  // Reading an article paragraph by paragraph.
  if (state.lensActive && state.article.length) {
    state.articleAt = Math.max(0, Math.min(state.article.length - 1, state.articleAt + dir));
    return state.article[state.articleAt];
  }
  // In the editor, next/previous moves a line and reads it.
  if (await bridgeActive()) {
    const s = await bridge.state();
    const target = Math.max(1, (s.line ?? 1) + dir);
    const r = await bridge.goto(target);
    return speakLine(target, r.lineText ?? '');
  }
  await toPrevApp();
  await pressKeys(dir === 1 ? 'down' : 'up');
  return readLines(1);
}

async function back(): Promise<string> {
  const prev = state.stack.pop();
  if (prev) {
    state.menu = prev;
    setUi({ level: prev.level, options: prev.items.map(({ label, detail }) => ({ label, detail })), optionsTitle: prev.title });
    return speakOptions(prev.title, prev.items, prev.offset);
  }
  if (state.lensActive && state.lensPage) {
    await rpc('lens.back', {});
    return 'Went back.';
  }
  return listWindows();
}

// ------------------------------------------------------------------ typing & keys

async function typeInto(text: string): Promise<string> {
  if (state.lensActive && state.pendingInput) {
    await rpc('lens.fill', { id: state.pendingInput.id, text });
    return `Typed ${text}. Say enter to submit.`;
  }
  await toPrevApp();
  state.suppressFollowUntil = Date.now() + 1500;
  await insertText(text);
  return `Typed ${text.length > 60 ? text.slice(0, 60) + '…' : text}.`;
}

async function dictateCode(spoken: string): Promise<Reply> {
  if (!claudeAvailable()) return { speak: await typeInto(spoken) };
  await toPrevApp();
  let lang = 'plaintext', around = '▮';
  if (await bridgeActive()) {
    const s = await bridge.state();
    lang = s.languageId ?? lang;
    if (s.line) {
      const ls = await bridge.lines(Math.max(1, s.line - 6), s.line + 3);
      around = ls.map((l) => (l.n === s.line ? l.text.slice(0, (s.column ?? 1) - 1) + '▮' + l.text.slice((s.column ?? 1) - 1) : l.text)).join('\n');
    }
  }
  setUi({ status: 'thinking' });
  const code = await spokenToCode(spoken, lang, around);
  state.suppressFollowUntil = Date.now() + 1500;
  await insertText(code);
  return { speak: `Inserted: ${code.split('\n')[0].trim()}${code.includes('\n') ? `, plus ${code.split('\n').length - 1} more lines` : ''}.`, via: 'claude' };
}

async function press(keys: string): Promise<string> {
  if (state.lensActive) {
    await rpc('lens.key', { key: keys });
    if (keys === 'return' && state.pendingInput) {
      state.pendingInput = null;
      await new Promise((r) => setTimeout(r, 900));
      return 'Submitted. ' + (await webView('outline', true));
    }
    return `${spokenKeys(keys)}.`;
  }
  await toPrevApp();
  if (keys === 'cmd+s' && (await bridgeActive())) {
    await bridge.save();
    const d = (await bridge.state()).diagnostics;
    return `Saved.${d?.errors ? ` ${d.errors} errors.` : ''}`;
  }
  await pressKeys(keys);
  return `${spokenKeys(keys)}.`;
}

async function click(target: string): Promise<string> {
  if (state.lensActive && state.lensPage) {
    const page = await refreshLens();
    const hit = fuzzyPick(target, page.items.filter((i) => i.kind !== 'heading' && i.kind !== 'region'), (i) => i.label);
    if (hit) return activateLens(hit);
    return `No ${target} on this page. Say links or buttons.`;
  }
  const tree = await axTree();
  const flat: AxNode[] = [];
  const walk = (ns: AxNode[]) => ns.forEach((n) => { if (n.actionable) flat.push(n); if (n.children) walk(n.children); });
  walk(tree.tree);
  const hit = fuzzyPick(target, flat, (n) => n.label ?? n.value ?? '');
  if (hit) {
    await axPress(hit.path);
    return `${hit.label ?? target}.`;
  }
  if (claudeAvailable()) return (await ask(`click ${target}`)).speak;
  return `I can't find ${target}. Say read screen.`;
}

// ------------------------------------------------------------------ screen reading

async function screenText(): Promise<{ text: string; via: 'grammar' | 'gemini' | 'claude' }> {
  const tree = await axTree(25, 350);
  if (countNodes(tree.tree) >= 12) {
    return { text: `App: ${tree.app}\nWindow: ${tree.title}\n${treeToText(tree.tree)}`, via: 'grammar' };
  }
  const v = await describeScreen();
  return { text: `App: ${tree.app}\nWindow: ${tree.title}\n(Accessibility tree was empty; this is a vision transcription.)\n${v.text}`, via: v.via };
}

async function readScreen(goal?: string): Promise<Reply> {
  if (state.lensActive && state.lensPage) return { speak: await webView('outline') };
  await toPrevApp();
  setUi({ status: 'thinking' });
  const screen = await screenText();
  if (!claudeAvailable()) {
    const lines = screen.text.split('\n').filter((l) => /"|=/.test(l)).slice(0, 8).map((l) => l.trim().replace(/\{[\d.]+\}/, ''));
    return { speak: lines.join('. ') };
  }
  const n = await narrateScreen(screen.text, goal, state.recent.join('\n'));
  if (n.options.length) {
    const items: OptionItem<Action>[] = n.options.map((o) => ({ label: o.label, action: o.path ? { t: 'ax', path: o.path, label: o.label } : { t: 'say', text: o.label } }));
    state.menu = null;
    showMenu('On screen', 'App', items, false);
    return { speak: `${n.speak} ${items.map((it, i) => `${i + 1}, ${it.label}`).join('. ')}.`, via: screen.via === 'gemini' ? 'gemini' : 'claude' };
  }
  return { speak: n.speak, via: 'claude' };
}

// ------------------------------------------------------------------ Lens browser

async function showLens(): Promise<string> {
  state.lensActive = true;
  setUi({ view: 'lens', level: 'Web' });
  mainWin?.show();
  mainWin?.focus();
  if (state.lensPage) return `Lens, ${state.lensPage.title}. Say outline, links, or search.`;
  return 'Lens browser. Say search, then what you want, or open a website.';
}

async function lensGo(url: string, title?: string): Promise<string> {
  await showLens();
  state.pendingInput = null;
  state.article = [];
  if (ui.performance) {
    const page = await fetchPage(url);
    state.lensPage = page;
    await rpc('lens.showPage', { page });
  } else {
    await rpc('lens.navigate', { url }, 20000);
    state.lensPage = await rpc<LensPage>('lens.extract', {});
  }
  return summarizePage(state.lensPage!, title);
}

async function refreshLens(): Promise<LensPage> {
  if (!ui.performance) state.lensPage = await rpc<LensPage>('lens.extract', {});
  return state.lensPage!;
}

function lensOption(i: LensItem, showKind = true): OptionItem<Action> {
  const kindWord: Record<string, string> = { link: 'link', button: 'button', input: 'field', heading: `heading ${i.level ?? ''}`.trim(), result: '', region: 'region', text: '' };
  return { label: i.label, detail: (showKind && kindWord[i.kind]) || undefined, action: i.kind === 'region' ? { t: 'region', item: i } : { t: 'lens', item: i } };
}

function summarizePage(page: LensPage, title?: string): string {
  const results = page.items.filter((i) => i.kind === 'result');
  if (results.length) return showMenu(title ?? page.title, 'Web', results.map((i) => lensOption(i, false)), false);
  const regions = page.items.filter((i) => i.kind === 'region' && (i.children?.length ?? 0) > 0);
  if (regions.length > 1) {
    const items = regions.map((r) => ({ ...lensOption(r), detail: regionDetail(r) }));
    return `${page.title}. ` + showMenu('Regions', 'Web', items, false);
  }
  clearMenu('Web');
  const h = page.items.filter((i) => i.kind === 'heading').slice(0, 3).map((x) => x.label);
  return `${page.title}. ${h.length ? `Headings: ${h.join('. ')}.` : ''} Say links, headings, form, or read article.`;
}

function regionDetail(r: LensItem): string {
  const c = r.count;
  if (!c) return '';
  const n = (k: number, word: string) => k && `${k} ${word}${k === 1 ? '' : 's'}`;
  const parts = [n(c.headings, 'heading'), n(c.links, 'link'), n(c.inputs, 'field'), n(c.buttons, 'button')].filter(Boolean);
  return parts.join(', ');
}

async function webView(view: 'outline' | 'headings' | 'links' | 'forms' | 'buttons' | 'article', fresh = false): Promise<string> {
  if (!state.lensPage) return 'No page open. Say search, then what you want.';
  state.lensActive = true;
  const page = fresh || !ui.performance ? await refreshLens() : state.lensPage;
  if (view === 'outline') return summarizePage(page);
  if (view === 'article') {
    state.article = page.article.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 30);
    state.articleAt = 0;
    return state.article.length ? `${state.article.length} paragraphs. ${state.article[0]}` : 'No article text on this page.';
  }
  const kinds = { headings: ['heading'], links: ['link', 'result'], forms: ['input'], buttons: ['button'] }[view];
  const items = page.items.filter((i) => kinds.includes(i.kind));
  return showMenu(view === 'forms' ? 'Form fields' : view[0].toUpperCase() + view.slice(1), 'Web', items.map((i) => lensOption(i, false)));
}

async function activateLens(item: LensItem): Promise<string> {
  if (item.kind === 'input') {
    state.pendingInput = item;
    if (!ui.performance) await rpc('lens.activate', { id: item.id });
    return `${item.label} field. Say type, then your text.`;
  }
  if (item.kind === 'heading') {
    if (!ui.performance) await rpc('lens.activate', { id: item.id });
    return `Heading: ${item.label}.`;
  }
  if (ui.performance || item.kind === 'result') {
    if (item.href) return lensGo(item.href);
  }
  await rpc('lens.activate', { id: item.id });
  await new Promise((r) => setTimeout(r, 900));
  const page = await refreshLens();
  return `Opened ${item.label}. ` + summarizePage(page);
}

// ------------------------------------------------------------------ messages

async function unread(): Promise<Reply> {
  setUi({ status: 'thinking' });
  const msgs = await unreadMessages();
  if (!msgs.length) return { speak: 'No unread messages.' };
  const named = await Promise.all(msgs.map(async (m) => ({ ...m, name: await contactName(m.sender) })));
  const threads = new Map<string, typeof named>();
  for (const m of named) threads.set(m.chatId, [...(threads.get(m.chatId) ?? []), m]);
  const items: OptionItem<Action>[] = [...threads.values()].map((t) => ({
    label: t[0].isGroup ? t[0].chatName ?? 'Group chat' : t[0].name,
    detail: `${t.length} unread`,
    action: { t: 'thread', handle: t[0].isGroup ? t[0].chatId : t[0].sender, name: t[0].isGroup ? t[0].chatName ?? 'the group' : t[0].name, text: t.slice().reverse().map((m) => (t[0].isGroup ? `${m.name} says ${m.text}` : m.text)).join('. ') },
  }));
  state.menu = null;
  showMenu('Unread', 'Messages', items, false);
  if (items.length === 1) {
    const a = items[0].action as Extract<Action, { t: 'thread' }>;
    state.replyTo = { handle: a.handle, name: a.name };
  }
  if (!claudeAvailable()) return { speak: speakOptions('Unread conversations', items) };
  return { speak: await summarizeUnread(digest(named)), via: 'claude' };
}

async function reply(to: string | undefined, text: string): Promise<string> {
  let target = state.replyTo;
  if (to) {
    const threads = (state.menu?.items ?? []).filter((i) => i.action.t === 'thread');
    const hit = fuzzyPick(to, threads, (i) => i.label);
    if (hit) {
      const a = hit.action as Extract<Action, { t: 'thread' }>;
      target = { handle: a.handle, name: a.name };
    } else {
      target = { handle: to, name: to };
    }
  }
  if (!target) return 'Who should I send that to? Say text, a name, then the message.';
  await sendMessage(target.handle, text);
  state.replyTo = target;
  return `Sent to ${target.name}: ${text}`;
}

// ------------------------------------------------------------------ Claude operator

async function ask(text: string): Promise<Reply> {
  if (!claudeAvailable()) return { speak: "I didn't catch a command. Say help for the list. Add an Anthropic key for free-form requests." };
  setUi({ status: 'thinking' });
  const front = await axFront().catch(() => null);
  const editor = (await bridgeActive()) ? await bridge.state().catch(() => null) : null;
  const context = [
    `Frontmost app: ${state.lensActive ? 'Callbacks Lens browser' : front?.app ?? 'unknown'}${front?.title ? ` — ${front.title}` : ''}`,
    state.lensActive && state.lensPage ? `Lens page: ${state.lensPage.title} (${state.lensPage.url})` : '',
    editor?.line ? `Editor: ${editor.relPath} line ${editor.line} col ${editor.column}: ${editor.lineText}` : '',
    state.menu ? `Last spoken list "${state.menu.title}": ${state.menu.items.slice(0, 9).map((it, i) => `${i + 1}. ${it.label}`).join('; ')}` : '',
    `Recent:\n${state.recent.slice(-8).join('\n')}`,
  ].filter(Boolean).join('\n');
  const speakText = await operator(text, context, runTool, (name) => log('system', `→ ${name}`, 'claude'));
  return { speak: speakText, via: 'claude' };
}

let agentWindows: WindowInfo[] = [];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(input[k] ?? '');
  const n = (k: string) => Number(input[k]);
  switch (name) {
    case 'list_windows':
      agentWindows = await axWindows();
      return agentWindows.map((w, i) => `${i + 1}. ${w.app}${w.title ? ` — ${w.title}` : ''}${w.frontmost ? ' (front)' : ''}`).join('\n');
    case 'focus_window': {
      const w = agentWindows[n('number') - 1];
      return w ? focusWindow(w) : 'No such window; call list_windows first.';
    }
    case 'open_app': return open(s('name'));
    case 'open_url': return lensGo(normalizeUrl(s('url')));
    case 'web_search': return lensGo(searchUrl(s('query')));
    case 'web_outline': {
      const page = await refreshLens();
      return JSON.stringify({ title: page.title, url: page.url, items: page.items.slice(0, 120).map(({ id, kind, label, href }) => ({ id, kind, label, href })) });
    }
    case 'web_activate': {
      const item = state.lensPage?.items.find((i) => i.id === s('id'));
      return item ? activateLens(item) : 'Unknown id; call web_outline.';
    }
    case 'web_fill': await rpc('lens.fill', { id: s('id'), text: s('text') }); return 'Filled.';
    case 'editor_state': return JSON.stringify(await bridge.state());
    case 'go_to_line': return speakLine(n('line'), (await goToLine(n('line'))).text);
    case 'read_lines': return (await bridge.lines(n('from'), n('to'))).map((l) => `${l.n}: ${l.text}`).join('\n');
    case 'diagnostics': return JSON.stringify(await bridge.diagnostics());
    case 'insert_text': await toPrevApp(); state.suppressFollowUntil = Date.now() + 1500; return `Inserted via ${await insertText(s('text'))}.`;
    case 'replace_line': await bridge.replaceLine(n('line'), s('text')); return `Line ${n('line')} replaced.`;
    case 'press_keys': return press(s('keys'));
    case 'read_screen': return (await screenText()).text;
    case 'press_element': return (await axPress(s('path'))).ok ? 'Pressed.' : 'Press failed.';
    case 'unread_messages': {
      const msgs = await unreadMessages();
      const named = await Promise.all(msgs.map(async (m) => ({ ...m, name: await contactName(m.sender) })));
      return digest(named) || 'No unread messages.';
    }
    case 'send_message': await sendMessage(s('to'), s('text')); return `Sent to ${s('to')}.`;
  }
  return `Unknown tool ${name}`;
}

// ------------------------------------------------------------------ follow mode

let followSeq = 0;
let lastFocusedValue = '';
let followTimer: NodeJS.Timeout | null = null;

export function startFollowLoop() {
  if (followTimer) return;
  followTimer = setInterval(async () => {
    if (!ui.follow || ui.status !== 'idle' || Date.now() < state.suppressFollowUntil) return;
    try {
      if (await bridgeActive()) {
        const { seq, events } = await bridge.events(followSeq);
        const first = followSeq === 0;
        followSeq = seq;
        if (first) return;
        const done = events.filter((e) => e.type === 'edit' && e.newline).pop();
        const diag = events.filter((e) => e.type === 'diagnostics').pop();
        if (done?.line && done.line > 1) {
          const [prev] = await bridge.lines(done.line, done.line);
          if (prev?.text.trim()) speak(speakLine(prev.n, prev.text), { via: 'follow' });
        } else if (diag && (diag.errors ?? 0) > 0) {
          speak(`${diag.errors} error${diag.errors === 1 ? '' : 's'}.`, { via: 'follow' });
        }
        return;
      }
      // Generic: read text appended to the focused text area (terminal output, chat logs).
      const f = await axFocused();
      const v = f.value ?? '';
      if (lastFocusedValue && v.startsWith(lastFocusedValue) && v.length > lastFocusedValue.length) {
        const added = v.slice(lastFocusedValue.length).trim();
        if (added.length > 1) speak(added.split('\n').slice(-4).join('. ').slice(0, 300), { via: 'follow' });
      }
      lastFocusedValue = v;
    } catch { /* nothing focused / bridge down */ }
  }, 700);
}

export function shortcodeHelp(): Array<[string, string]> {
  return SHORTCODES;
}
