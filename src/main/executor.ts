// The dispatcher. Every input (voice, typed shortcode, Claude tool call) becomes a
// Command and runs through handle(). Navigation is hierarchical:
//
//   system  — which window/app am I in?            ("windows", "3")
//   app     — which region of this app?            ("read screen", "click save")
//   content — which line/item inside the region?   ("go to line 42", "next")
//   web     — Lens page regions → items             ("outline", "links", "2")
//
// "back" walks up a level; numbers pick from whatever list was last spoken.

import { webContents, type BrowserWindow } from 'electron';
import { parseCommand, SHORTCODES, type Command, type Source, type WebView } from '../core/commands';
import { compact, setSpokenOptions, speakOptions, shortPageTitle, MAX_SPOKEN_OPTIONS, type OptionItem } from '../core/narration';
import { skim } from '../core/skim';
import type { LensItem, LensPage } from '../shared/types';
import { claudeAvailable, describeImage, detectElements, firstGlance, narrateScreen, operator, spokenToCode, summarizeChange, summarizeUnread, warmCaches, type Glance, type ToolResult } from './claude';
import { setCurtain } from './curtain';
import { bridge, bridgeActive, goToLine, insertText, readLines, speakLine } from './editor';
import { contactName, digest, findContacts, isHandle, sendMessage, unreadMessages } from './messages';
import { axFocus, axFocused, axFront, axPress, axTree, axWindows, countNodes, treeToText, type AxNode, type FrontInfo, type WindowInfo } from './native';
import { log, onInterrupted, repeatLast, setBraille, setUi, speak, speakStreamEnd, speakStreamPart, speakStreamStart, stopSpeech, ui, type Heard } from './output';
import { resetForDemo } from './reset';
import { rpc } from './rpc';
import { exactApp, fuzzyPick, fuzzyScore, openApp, pressKeys, resolveApp, spokenKeys } from './system';
import { describeScreen } from './vision';
import { config, effectiveStt, effectiveTts, setVoiceProvider } from './config';
import { synthesizeCached } from './voice';
import { fetchPage, gameUrl, isKnownSite, resolveGame, looksLikeUrl, normalizeUrl, resolveSite, searchUrl } from './web';

type Action =
  | { t: 'window'; w: WindowInfo }
  | { t: 'app'; app: string; wins: WindowInfo[] }
  | { t: 'point'; x: number; y: number; label: string }
  | { t: 'ax'; path: string; label: string }
  | { t: 'lens'; item: LensItem }
  | { t: 'region'; item: LensItem }
  | { t: 'thread'; handle: string; name: string; text: string }
  | { t: 'say'; text: string };

interface Reply { speak: string; via?: 'grammar' | 'claude' | 'gemini'; quiet?: boolean }

/**
 * The current command's streamed speech, if any part of its reply was already spoken while it
 * was being written (Claude's answer, a page's first look). runText then only logs the whole.
 */
let streamGen: number | null = null;
/** While Claude works through tools, pages it opens don't speak; its answer comes at the end. */
let inOperator = false;
function streamSentence(gen: number, s: string, fromOperator = false) {
  if (gen !== cmdGen || (inOperator && !fromOperator)) return;
  if (streamGen == null) streamGen = speakStreamStart();
  speakStreamPart(streamGen, s);
}

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
  /** Pages visited in the Lens, so "back" is predictable and can say where it landed. */
  history: [] as Array<{ url: string; title: string }>,
  reading: 'article' as 'article' | 'comments',
  /** The last feed read (its posts in order) and which one is open, for "next post" from anywhere. */
  feed: null as { url: string; posts: Array<{ title: string; href: string }>; index: number } | null,
  /** The list position last opened or heard (1-based), so "the next post" means the one after it. */
  lastPick: null as number | null,
  /** The crossword clue last selected ("2 down"): re-clicked right before typing its answer. */
  crosswordClue: null as string | null,
  /** "m Krishna": waiting for what the message should say. */
  compose: null as { to: string } | null,
  /** A message read back and waiting for "yes". Nothing is sent without it. */
  pendingSend: null as { handle: string; name: string; text: string } | null,
  /**
   * The question the user is trying to answer ("fact check this", "when did X happen"), with the
   * context it referred to. Later steps ("click the first link") serve it, and the first page
   * that answers it says the answer.
   */
  goal: null as { text: string; about: string; at: number } | null,
};

const GOAL = /^(fact[- ]?check|check (if|whether|that)|verify|is (it|that|this) (true|right|correct)|find out|look up|figure out|research|what|when|where|who|why|how|which|does|did|is|are|can|should)\b|\?$/i;
const goalNow = () => (state.goal && Date.now() - state.goal.at < 5 * 60_000 ? state.goal : null);

/** Top-level comments as spoken lines: "dadjokes, 2.5K points: ..." (replies are skipped). */
function commentLines(page: LensPage): string[] {
  return (page.blocks ?? []).filter((b) => b.kind === 'comment' && (b.depth ?? 0) === 0).map((c) => {
    const who = [c.author, c.score ? `${c.score} points` : ''].filter(Boolean).join(', ');
    const words = c.text.split(' ');
    return `${who ? `${who}: ` : ''}${words.slice(0, 70).join(' ')}${words.length > 70 ? '…' : ''}`;
  });
}

/**
 * Where the user cut in. If it was during a spoken list, `index` is the item they had just
 * heard; "click that" / "that one" then means it. People react a beat late, so an item that
 * had only just started counts as the one before it.
 */
let heard: (Heard & { index: number | null }) | null = null;
onInterrupted((h) => {
  let index: number | null = null;
  const m = state.menu;
  if (m) {
    let from = 0;
    const spans: Array<{ i: number; start: number; end: number }> = [];
    for (let i = m.offset; i < Math.min(m.items.length, m.offset + MAX_SPOKEN_OPTIONS); i++) {
      const it = m.items[i];
      const words = (it.say ?? compact(it.label)).split(' ');
      const start = h.text.indexOf(words.slice(0, 3).join(' '), from);
      if (start < 0) continue;
      spans.push({ i, start, end: start + words.join(' ').length });
      from = start + 1;
    }
    const cur = [...spans].reverse().find((sp) => sp.start <= h.pos);
    if (cur) {
      const prev = spans[spans.indexOf(cur) - 1];
      index = (h.pos - cur.start < 12 && prev ? prev.i : cur.i) + 1;
    }
  }
  heard = { ...h, index };
  if (index && state.menu?.items[index - 1]) showOnPage([state.menu.items[index - 1]]);
  log('system', `(interrupted at: "…${h.text.slice(Math.max(0, h.pos - 40), h.pos)}"${index ? `, item ${index}` : ''})`);
});

/** "That" from an interruption, if it's fresh (the last ~30 seconds). */
const heardItem = () => (heard && heard.index && Date.now() - heard.at < 30000 ? heard.index : null);

/** Bumped on every command; a slower, older command must not talk over a newer one. */
let cmdGen = 0;
/** Set when Claude ran during the current command, so the transcript credits it. */
let usedClaude = false;
let lastCommandAt = 0;
/** Commands in flight; watch mode stays silent while any is running. */
let busy = 0;
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 };

let mainWin: BrowserWindow | null = null;
export function attachExecutorWindow(w: BrowserWindow) {
  mainWin = w;
}

// ------------------------------------------------------------------ entry point

/**
 * The two nyxOS views by voice, from anywhere. "Home page" is left alone: on a site it means
 * the site's own front page.
 */
const NYX_HOME = /^(?:(?:ok |okay |hey )?(?:nyx,? )?)(?:(?:go |go back |back |take me |switch |return )?(?:to )?(?:the )?(?:nyx ?(?:os )?)?home(?: screen| view| tab)?|(?:exit|leave|close|hide)(?: the)? lens)(?: please)?$/i;
/** "Reset window", "fresh start": relaunch clean, for demo recordings (also ⌘⇧R). */
const NYX_RESET = /^(?:(?:ok |okay |hey )?(?:nyx,? )?)(?:reset(?: the)? (?:window|app|nyx ?(?:os)?)|reset for (?:the |a )?demo|demo reset|fresh start|start fresh|clean slate)(?: please)?$/i;
const NYX_LENS = /^(?:(?:ok |okay |hey )?(?:nyx,? )?)(?:(?:open|show|show me|go to|go back to|back to|switch to|return to|take me to)(?: the)? )?lens(?: view| tab)?(?: please)?$/i;

export async function runText(text: string, source: Source): Promise<void> {
  const started = Date.now();
  const gen = ++cmdGen;
  lastCommandAt = Date.now();
  busy++;
  log('user', text, source);
  let cmd: Command = parseCommand(text, source) ?? { kind: 'ask', text };
  // A message waiting for "yes", or a message being composed, takes the next utterance first.
  const said = text.replace(/[.!?]+$/, '').trim();
  if (state.pendingSend) {
    const p = state.pendingSend;
    if (/^(yes|yeah|yep|send|send it|confirm|do it|go ahead)$/i.test(said)) {
      state.pendingSend = null;
      busy--;
      try { await sendMessage(p.handle, p.text); state.replyTo = { handle: p.handle, name: p.name }; await speak(ui.discreet ? 'Sent.' : `Sent to ${p.name}.`, { via: 'grammar', ms: Date.now() - started }); }
      catch (e) { await speak(`Couldn't send: ${friendlyError(e)}`, { via: 'grammar' }); }
      return;
    }
    const keep = ['discreet', 'verbosity', 'repeat', 'rate'].includes(cmd.kind);
    const edited = keep ? null : editDraft(p.text, said);
    if (edited != null) {
      busy--;
      p.text = edited;
      await speak(ui.discreet ? 'Updated. Say yes to send.' : `Now: ${edited}. Say yes to send.`, { via: 'grammar', ms: Date.now() - started });
      return;
    }
    if (!keep) state.pendingSend = null;
    if (/^(no|nope|cancel|don'?t|stop)$/i.test(said)) { busy--; await speak('Not sent.', { via: 'grammar' }); return; }
  }
  if (state.compose && cmd.kind === 'ask') cmd = { kind: 'reply', to: state.compose.to, text };
  state.compose = null;
  if (NYX_RESET.test(said)) { busy--; resetForDemo(); return; }
  if (NYX_HOME.test(said)) cmd = { kind: 'open', target: 'home' };
  else if (NYX_LENS.test(said)) cmd = { kind: 'open', target: 'lens' };
  // Before asking Claude: is the utterance just a site or app name, or something already in front of the user?
  if (cmd.kind === 'ask' && heardItem() && /^(that|that one|this one|this|yes that|yeah that|that's it|there|go there)( one)?$/i.test(said.replace(/^(yes|yeah|yep|ok|okay),? /i, ''))) {
    cmd = { kind: 'choose', index: heardItem()! };
  }
  if (cmd.kind === 'ask') {
    const bare = cmd.text.replace(/[.!?]+$/, '').trim();
    if (/^(thanks|thank you|thank you so much|cool|ok|okay|great|nice|got it|perfect)$/i.test(bare)) { log('system', '(acknowledged)'); busy--; setUi({ status: 'idle' }); return; }
    const n = ordinal(bare) ?? menuIndex(bare, 85);
    const hit = n == null && state.lensActive && state.lensPage ? pageMatch(bare, 85) : null;
    if (n != null) cmd = { kind: 'choose', index: n };
    else if (hit) cmd = { kind: 'click', target: hit.label };
    else if (isKnownSite(bare) || looksLikeUrl(bare) || exactApp(bare)) cmd = { kind: 'open', target: bare };
  }
  usedClaude = false;
  streamGen = null;
  remember(`user: ${text}`);
  try {
    const instant = cmd.kind === 'ask' ? priceAnswer(cmd.text) : null;
    const reply: Reply = instant ? { speak: instant, via: 'grammar' } : await handle(cmd);
    if (gen !== cmdGen) { log('system', `(dropped an older reply: ${reply.speak.slice(0, 60)})`); return; }
    remember(`nyx: ${reply.speak}`);
    // Label who actually answered: a grammar command may have handed off to Claude midway.
    const via = reply.via ?? (cmd.kind === 'ask' || usedClaude ? 'claude' : 'grammar');
    const sg = streamGen;
    streamGen = null;
    if (sg != null && !reply.quiet) await speakStreamEnd(sg, reply.speak, { via, ms: Date.now() - started, startedAt: started });
    else await speak(reply.speak, { via, ms: Date.now() - started, quiet: reply.quiet, startedAt: started });
  } catch (e) {
    if (gen === cmdGen) await speak(friendlyError(e), { via: usedClaude ? 'claude' : 'grammar', ms: Date.now() - started });
  } finally {
    busy--;
    lastCommandAt = Date.now();
    // Never leave the orb on "Hearing" or "Working" once a command is done.
    if ((ui.status === 'thinking' || ui.status === 'transcribing') && gen === cmdGen) setUi({ status: 'idle' });
  }
}

/** "how much is the first one" / "how much does it cost": answered from prices already on screen. */
function priceAnswer(text: string): string | null {
  const m = text.toLowerCase().replace(/[?.!]+$/, '').match(/^(?:how much (?:money )?(?:is|are|does|do|for)?|what(?:'s| is) the (?:price|cost)(?: of| for)?|price(?: of| for)?)\s*(.*?)\s*(?:cost|costs)?$/);
  if (!m) return null;
  const target = m[1].replace(/^(it|this|that|this one|that one|the item|this item)$/, '').replace(/^(the|this|that)\s+/, '').trim();
  if (!target) return state.lensPage?.price ? `${state.lensPage.price}.` : null;
  const n = ordinal(target) ?? menuIndex(target, 70);
  const fromMenu = n != null ? state.menu?.items[n - 1] : undefined;
  if (fromMenu?.detail && /\d/.test(fromMenu.detail)) { showOnPage([fromMenu]); return `${compact(fromMenu.label, 4)}: ${fromMenu.detail}.`; }
  const hit = state.lensActive ? pageMatch(target, 70) : null;
  return hit?.price ? `${compact(hit.label, 4)}: ${hit.price}.` : null;
}

/**
 * Fix a message before it's sent, after Abdolrahmani et al. (ASSETS 2018): blind users found that
 * correcting one word meant re-dictating the whole message. Returns the new text, or null if the
 * utterance isn't an edit. "read it back" returns the text unchanged (it's re-read).
 */
function editDraft(text: string, said: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = said.match(/^(?:change|replace|swap) (.+?) (?:to|with|for) (.+)$/i))) {
    const i = text.toLowerCase().indexOf(m[1].toLowerCase());
    return i < 0 ? null : text.slice(0, i) + m[2] + text.slice(i + m[1].length);
  }
  if ((m = said.match(/^(?:add|append|and add|also say) (.+)$/i))) return `${text.replace(/[.!?]?$/, (p) => p || '')} ${m[1]}`.trim();
  if ((m = said.match(/^(?:remove|delete|take out|drop) (?:the word )?(.+)$/i))) {
    const i = text.toLowerCase().indexOf(m[1].toLowerCase());
    return i < 0 ? null : (text.slice(0, i) + text.slice(i + m[1].length)).replace(/\s{2,}/g, ' ').trim();
  }
  if ((m = said.match(/^(?:make it|change it to|instead say|say instead|actually say) (.+)$/i))) return m[1];
  if (/^(?:read it(?: back)?|what does it say|read the message)$/i.test(said)) return text;
  return null;
}

/** "the first one", "second result", "last" → a list position (1-based). */
function ordinal(text: string): number | null {
  // "that first post", "the second result", "open the last one", "go to the third video".
  const m = text.toLowerCase().replace(/[.!?]+$/, '').match(/^(?:(?:the|that|this|pick|choose|open|go to|click(?: on)?|read|play)\s+)*(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top)(?:\s+(?:one|result|item|link|option|post|article|story|video|product|comment|thing|answer|word|choice))?$/);
  if (!m || !state.menu) return null;
  const n = m[1] === 'top' ? 1 : ORDINALS[m[1]];
  return n === -1 ? state.menu.items.length : n;
}

/** Index (1-based) of the current list item the utterance names, if any. */
function menuIndex(text: string, min: number): number | null {
  const items = state.menu?.items ?? [];
  let best = -1, score = 0;
  if (min > 100) return null;
  items.forEach((it, i) => {
    const sc = Math.max(fuzzyScore(text, it.label), it.say ? fuzzyScore(text, it.say) : 0);
    if (sc > score) { score = sc; best = i; }
  });
  return best >= 0 && score >= min && text.trim().length > 2 ? best + 1 : null;
}

function remember(line: string) {
  state.recent.push(line);
  if (state.recent.length > 12) state.recent.shift();
}

function friendlyError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/not trusted|AXError|assistive/i.test(m)) return 'I need Accessibility permission. Open System Settings, Privacy and Security, Accessibility, and allow nyxOS.';
  if (/ECONNREFUSED|fetch failed/i.test(m)) return 'Network request failed.';
  return m.length > 220 ? m.slice(0, 220) : m;
}

// ------------------------------------------------------------------ menus

/**
 * Options that would sound alike ("Connections Archive" five times) get what tells them apart:
 * first the site they're on, then the words in their own text that the others don't share.
 */
function differentiate(items: OptionItem<Action>[]): OptionItem<Action>[] {
  const spoken = (it: OptionItem<Action>) => (it.say ?? compact(it.label)).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const groups = new Map<string, OptionItem<Action>[]>();
  for (const it of items) groups.set(spoken(it), [...(groups.get(spoken(it)) ?? []), it]);
  const hostOfItem = (it: OptionItem<Action>) => {
    const href = it.action.t === 'lens' ? it.action.item.href : undefined;
    try {
      if (!href) return '';
      // Search engines wrap results in their own redirect (DuckDuckGo's uddg=, Google's url=): unwrap it.
      const u = new URL(href, 'https://duckduckgo.com');
      const real = u.searchParams.get('uddg') ?? u.searchParams.get('url') ?? u.searchParams.get('q');
      return new URL(real && /^https?:/.test(real) ? real : u.href).hostname.replace(/^www\./, '');
    } catch { return ''; }
  };
  const STOPS = new Set('the a an and or of to in for on with is are was by from at this that your you it as be free'.split(' '));
  const wordsOf = (it: OptionItem<Action>) => it.label.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPS.has(w));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const hosts = group.map(hostOfItem);
    const hostsDiffer = new Set(hosts).size > 1;
    group.forEach((it, i) => {
      const base = it.say ?? compact(it.label);
      // Words only this one has ("free", "answers", "2024"), from its full title and snippet.
      const others = new Set(group.filter((o) => o !== it).flatMap(wordsOf));
      const own = [...new Set(wordsOf(it).filter((w) => !others.has(w) && !base.toLowerCase().includes(w) && !(hosts[i] ?? '').includes(w)))].slice(0, 3);
      const site = hostsDiffer && hosts[i] ? `from ${hosts[i]}` : '';
      const extra = [site, own.length ? own.join(' ') : ''].filter(Boolean).join(', ');
      it.say = extra ? `${base}, ${extra}` : `${base} ${i + 1}`;
    });
  }
  return items;
}

function showMenu(title: string, level: string, items: OptionItem<Action>[], push = true): string {
  items = differentiate(items);
  if (push && state.menu) state.stack.push(state.menu);
  state.menu = { title, level, items, offset: 0 };
  setUi({ level, options: items.map(({ label, detail, say }) => ({ label, detail: detail ?? (say && say.includes(', from ') ? say.slice(say.indexOf(', from ') + 2) : undefined) })), optionsTitle: title });
  refreshBraille();
  showOnPage(items.slice(0, MAX_SPOKEN_OPTIONS));
  return speakOptions(title, items);
}

/** Keep what we're talking about on screen: outline these page items and scroll to the first. */
function showOnPage(items: OptionItem<Action>[]) {
  if (!state.lensActive || ui.performance) return;
  const ids = items.flatMap((it) => (it.action.t === 'lens' || it.action.t === 'region' ? [it.action.item.id] : []));
  if (ids.length) rpc('lens.highlight', { ids }, 3000).catch(() => undefined);
}

function clearMenu(level: string) {
  state.menu = null;
  state.stack = [];
  setUi({ level, options: [], optionsTitle: '' });
  refreshBraille();
}

/**
 * The braille display shows what's on screen, condensed: the page, then the options in order
 * (with prices), or the page's headings when there's no list. Separated by " · " so each entry
 * starts fresh on the cells.
 */
function refreshBraille() {
  const parts: string[] = [];
  const page = state.lensActive ? state.lensPage : null;
  if (page) parts.push(shortPageTitle(page.title) + (page.price ? ` ${page.price}` : ''));
  if (state.menu) {
    // The list's title often already names the site ("Amazon, protein shakes"): don't say it twice.
    if (page && state.menu.title.toLowerCase().startsWith(parts[0]?.split(' ')[0]?.toLowerCase() ?? '\0')) parts[0] = state.menu.title;
    else if (!page || state.menu.title !== shortPageTitle(page.title)) parts.push(state.menu.title);
    parts.push(...state.menu.items.slice(0, 40).map((it) => it.say ?? compact(it.label, 6)));
  } else if (page) {
    parts.push(...page.items.filter((i) => i.kind === 'heading').slice(0, 12).map((i) => compact(i.label, 6)));
  }
  setBraille(parts.filter(Boolean).join(' · '));
}

// ------------------------------------------------------------------ main switch

export async function handle(cmd: Command): Promise<Reply> {
  switch (cmd.kind) {
    case 'stop':
      stopSpeech();
      if (state.lensActive) rpc('lens.stopClicks', {}, 2000).catch(() => undefined);
      return { speak: '', quiet: true };
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
    case 'voice': return { speak: switchVoice(cmd.provider) };
    case 'relative': return { speak: await relative(cmd.dir, cmd.noun) };
    case 'verbosity':
      setUi({ verbosity: cmd.level });
      setSpokenOptions({ brief: 3, normal: 5, detailed: 8 }[cmd.level]);
      return { speak: { brief: 'Brief.', normal: 'Normal detail.', detailed: 'More detail from now on.' }[cmd.level] };
    case 'discreet':
      setUi({ discreet: cmd.on });
      return { speak: cmd.on ? "Discreet mode. I won't say names or message text aloud." : 'Discreet mode off.' };
    case 'follow': setUi({ follow: cmd.on }); return { speak: cmd.on ? 'Follow mode on. I will read new lines as they appear.' : 'Follow mode off.' };

    case 'windows': return { speak: await listWindows() };
    case 'choose': return { speak: await choose(cmd.index) };
    case 'next': return { speak: await step(1) };
    case 'previous': return { speak: await step(-1) };
    case 'back': return { speak: await back() };
    case 'whereAmI': return { speak: await whereAmI() };

    case 'open': return { speak: await open(cmd.target, cmd.play) };
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
    case 'click': {
      // Tile games: "select those four (and submit)", "select those three plus Möbius", "the last four".
      resolveNote = '';
      const set = state.lensActive && state.lensPage ? await resolveTiles(cmd.target) : null;
      if (set && (set.length > 1 || cmd.submit)) return { speak: await selectTiles(set, Boolean(cmd.submit)) };
      if (resolveNote) return { speak: resolveNote };
      // Couldn't resolve the tiles here: Claude does the whole thing (select and submit) once.
      if (cmd.submit) return claudeAvailable() ? ask(`select ${cmd.target} and submit`) : { speak: `Couldn't find ${cmd.target}.` };
      return { speak: await click(cmd.target, cmd.times) };
    }
    case 'scroll':
      if (state.lensActive) { await rpc('lens.scroll', { direction: cmd.direction }); return { speak: `Scrolled ${cmd.direction}.` }; }
      await toPrevApp();
      await pressKeys(cmd.direction === 'down' ? 'pagedown' : 'pageup');
      return { speak: `Page ${cmd.direction}.` };

    case 'readScreen': return await readScreen(cmd.goal);
    case 'search':
      // "protein powder under $20" on a shop: Claude searches the product, then sets the site's filters.
      if (cmd.qualified && !cmd.web && state.lensActive && state.lensPage && !/duckduckgo/.test(state.lensPage.url) && siteSearchBox(state.lensPage) && claudeAvailable()) return ask(`search for ${cmd.query}`);
      return { speak: await search(cmd.query, cmd.web) };
    case 'web':
      // "More comments" while reading comments: keep going from where we are.
      if (cmd.more && cmd.view === 'comments' && state.reading === 'comments' && state.article.length) {
        const said: string[] = [];
        for (let i = 0; i < 3; i++) { const s = await step(1); said.push(s); if (/^No more comments/.test(s)) break; }
        return { speak: said.join(' ') };
      }
      return { speak: await webView(cmd.view) };

    case 'unread': return await unread();
    case 'reply': return { speak: await reply(cmd.to, cmd.text) };

    case 'ask': return await ask(cmd.text);
  }
}

function switchVoice(want: 'cartesia' | 'elevenlabs' | 'next'): string {
  const target = want === 'next' ? (config.ttsProvider === 'cartesia' ? 'elevenlabs' : 'cartesia') : want;
  const name = target === 'cartesia' ? 'Cartesia' : 'ElevenLabs';
  if (!setVoiceProvider(target)) return `No ${name} key. Add ${target === 'cartesia' ? 'CARTESIA_API_KEY' : 'ELEVENLABS_API_KEY'} to the .env file.`;
  setUi({ providers: { ...ui.providers, tts: effectiveTts(), stt: effectiveStt() } });
  return `Voice: ${name}.`;
}

function helpText(): string {
  return 'Windows, open, go to line, type, press, read line, read screen, search, links, headings, unread, reply. Numbers pick. Back goes up. Anything else, just ask.';
}

// ------------------------------------------------------------------ system level

async function listWindows(): Promise<string> {
  const wins = (await axWindows()).filter((w) => w.app !== 'Electron' && w.app !== 'nyxOS');
  // One entry per app (frontmost first); an app with several windows opens a submenu.
  const byApp = new Map<string, WindowInfo[]>();
  for (const w of wins.sort((a, b) => Number(b.frontmost) - Number(a.frontmost))) byApp.set(w.app, [...(byApp.get(w.app) ?? []), w]);
  const items: OptionItem<Action>[] = [...byApp].map(([app, ws]) => ws.length === 1
    ? { label: app, detail: ws[0].title && ws[0].title !== app ? shortTitle(ws[0].title) : undefined, say: compact(app, 3), action: { t: 'window', w: ws[0] } }
    : { label: app, detail: `${ws.length} windows`, say: compact(app, 3), action: { t: 'app', app, wins: ws } });
  items.unshift({ label: 'Lens browser', detail: state.lensPage?.title, say: 'Lens', action: { t: 'say', text: '__lens' } });
  state.stack = [];
  state.menu = null;
  return showMenu('Apps', 'Windows', items, false);
}

function appWindows(app: string, wins: WindowInfo[]): string {
  return showMenu(app, 'Windows', wins.map((w) => ({ label: shortTitle(w.title || app), say: compact(shortTitle(w.title || app), 4), action: { t: 'window', w } })));
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
  return `${w.app}${w.title && !extra ? `, ${compact(shortTitle(w.title), 5)}` : ''}${extra}.`;
}

/** If nyxOS itself has focus (typed command bar), hand focus back to the app the user was in. */
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
    if (f.app !== 'Electron' && f.app !== 'nyxOS') state.prevFront = f;
  } catch { /* no AX trust yet */ }
}

/** Why a tile phrase couldn't be resolved, when it's worth telling the user. */
let resolveNote = '';

/** The selectable tiles on the page (checkbox/radio tiles, like Connections' words). */
const tilesOf = (page: LensPage) => page.items.filter((i) => i.kind === 'input' && (i.inputType === 'checkbox' || i.inputType === 'radio') && i.label.trim().length > 1);
const normWord = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The tiles a phrase means: named words ("salad, candy and space"), the words just spoken
 * ("those four", "them"), the rest of the board ("the last four", "the remaining ones"), or a
 * mix ("those three plus Möbius"). Null if any part can't be resolved, so nothing is guessed.
 */
async function resolveTiles(text: string): Promise<LensItem[] | null> {
  const page = await refreshLens();
  const tiles = tilesOf(page);
  if (tiles.length < 4) return null;
  const parts = text.replace(/^(the|on)\s+/i, '').split(/\s*,\s*(?:and\s+|plus\s+)?|\s+(?:and|plus)\s+/).map((p) => p.trim()).filter(Boolean);
  const COUNT: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
  const out: LensItem[] = [];
  for (const part of parts) {
    const n = COUNT[(part.match(/\b(two|three|four|five|six)\b/i)?.[1] ?? '').toLowerCase()];
    if (/^(those|these|them|the ones you said|those words|all of them|both)( \w+)?$/i.test(part)) {
      // Words from the latest turns, newest first (yours and nyxOS's), until the count is met:
      // "what goes with banner, pop-up and overlay?" … "Interstitial." … "submit those four".
      const found: LensItem[] = [];
      for (const line of [...state.recent].reverse().slice(0, 6)) {
        const said = ` ${normWord(line.replace(/^(user|nyx):/, ''))} `;
        for (const t of tiles) if (said.includes(` ${normWord(t.label)} `) && !found.includes(t)) found.push(t);
        if (n ? found.length >= n : found.length > 0) break;
      }
      if (!found.length || (n && found.length !== n)) return null;
      out.push(...found);
    } else if (/^(?:the )?(last|remaining|rest|other|leftover)( \w+)?( of them| ones| words| tiles)?$|^the rest$/i.test(part)) {
      // The words still on the board (solved groups leave the grid), when that's the number meant.
      if (n && tiles.length !== n) { resolveNote = `There are ${tiles.length} words left, not ${n}.`; return null; }
      out.push(...tiles);
    } else {
      const hit = tiles.find((t) => normWord(t.label) === normWord(part)) ?? pageMatch(part, 85, { ...page, items: tiles });
      if (!hit) return null;
      out.push(hit);
    }
  }
  const uniq = [...new Map(out.map((t) => [t.id, t])).values()];
  return uniq.length ? uniq : null;
}

/**
 * Make exactly these tiles the selection (clear any others, leave already-selected ones alone,
 * select the rest), then submit if asked. Clicking toggles, so "select" must never flip a tile off.
 */
async function selectTiles(set: LensItem[], submit: boolean): Promise<string> {
  const want = new Set(set.map((t) => t.id));
  const checked = async () => new Set(await rpc<string[]>('lens.eval', { code: `[...document.querySelectorAll('[data-cb]')].filter((e) => e.checked).map((e) => e.dataset.cb)` }).catch(() => [] as string[]));
  let on = await checked();
  for (const id of on) if (!want.has(id)) await rpc('lens.realClick', { id }).catch(() => undefined);
  on = await checked();
  for (const t of set) if (!on.has(t.id)) await rpc('lens.realClick', { id: t.id }).catch(() => undefined);
  on = await checked();
  const missed = set.filter((t) => !on.has(t.id));
  const names = set.map((t) => compact(t.label.charAt(0) + t.label.slice(1).toLowerCase(), 3)).join(', ');
  if (missed.length) return `Couldn't select ${missed.map((t) => compact(t.label, 3)).join(', ')}.`;
  if (!submit) return `Selected ${names}.`;
  const disabled = await rpc<boolean | null>('lens.eval', { code: `(() => { const b = [...document.querySelectorAll('button')].find((x) => /^submit$/i.test((x.innerText || '').trim())); return b ? b.disabled || b.getAttribute('aria-disabled') === 'true' : null; })()` }).catch(() => null);
  if (disabled) return `Selected ${names}, but Submit is greyed out: the game wants a different number of words, or this guess was already tried.`;
  return `${names}. ${await press('return')}`;
}

/** "2 down", "1 across": select that crossword entry by clicking its clue, then read the clue. */
async function crosswordEntry(text: string): Promise<string | null> {
  const m = text.toLowerCase().match(/^(?:the )?(\d+)\s*-?\s*(across|down)$/);
  if (!m || !state.lensActive || !state.lensPage) return null;
  const page = await refreshLens();
  const re = new RegExp(`\\b${m[1]}\\s*-?\\s*${m[2]}\\b`, 'i');
  const clue = page.items.find((i) => i.kind === 'button' && re.test(i.label));
  const entry = page.items.find((i) => i.kind === 'input' && re.test(i.label));
  if (!clue && !entry) return null;
  if (clue) await rpc('lens.activate', { id: clue.id, times: 1 }).catch(() => undefined);
  else await rpc('lens.activate', { id: entry!.id, times: 1 }).catch(() => undefined);
  state.crosswordClue = clue?.id ?? null;
  state.pendingInput = entry ? { ...entry, inputType: 'crossword' } : null;
  const said = (entry?.label ?? clue!.label).replace(/\s+/g, ' ').replace(/ at row \d+, column \d+/i, '').trim();
  return `${said} Say type, then the answer.`;
}

async function open(target: string, play = false): Promise<string> {
  const t = target.trim();
  const cw = await crosswordEntry(t);
  if (cw) return cw;
  // A game: go straight to a playable board and start it.
  const game = gameUrl(t);
  if (game) { state.goal = null; return playGame(await resolveGame(game)); }
  if (play && claudeAvailable()) return (await ask(`find a free online ${t} game I can play, open it, and start it`)).speak;
  // Going to a different site starts something new: the open question is done.
  if (isKnownSite(t) || looksLikeUrl(t)) state.goal = null;
  if (/^(lens|the lens|browser|the browser|web|the web|nyx|nyxos|nyx os|callbacks)$/i.test(t)) return showLens();
  if (/^(home|the home screen|nyx home)$/i.test(t)) return showHome();
  if (looksLikeUrl(t)) {
    const said = await lensGo(normalizeUrl(t));
    // "cookiequicker.com" doesn't exist: look the name up instead of reading an error page.
    if (lastLoadFailed) return lensGo(await resolveSite(t.replace(/\.(com|org|net|io|ai|dev|app|co)\b.*$/i, '').replace(/[.]/g, ' ')));
    return said;
  }
  const fileMatch = t.match(/^(?:the )?file (.+)$/i);
  if (fileMatch && (await bridgeActive())) {
    const s = await bridge.open(fileMatch[1].replace(/\s+dot\s+/g, '.'));
    return `${s.relPath}, ${speakLine(s.line ?? 1, s.lineText ?? '')}`;
  }
  // "go to that", "open it": whatever was just discussed. Only Claude knows what that was.
  if (/^(that|it|this|there|that one|this one|that post|this post|that link|that page|that thing)$/i.test(t)) {
    if (heardItem()) return choose(heardItem()!);
    return claudeAvailable() ? (await ask(`open ${t}`)).speak : 'Open what?';
  }
  const app = exactApp(t);
  if (!app) {
    // "go to today's deals" while on Amazon means the link, not an app.
    const onPage = state.lensActive && state.lensPage;
    if (isKnownSite(t)) return lensGo(await resolveSite(t));
    const n = ordinal(t) ?? menuIndex(t, 80);
    if (n != null) return choose(n);
    const hit = onPage ? pageMatch(t, 80) : null;
    if (hit) return activateLens(hit);
    // "the next post", "more comments", "that video", "the reviews": about what's on screen, never a website.
    if (/\b(next|previous|prior|that|this|it|another|same|other|these|those|more|comments?|replies|reply|results?|reviews?|details?|description|photos?|pictures?|images?|videos?|top|bottom|rest|section|thread|page|answers?|post)\b/i.test(t) && claudeAvailable()) return (await ask(`show me ${t}`)).speak;
    if (!resolveApp(t, 60)) {
      // On a page, a name that partly matches something there may be a misheard link: Claude decides.
      // A name unrelated to the page ("CS70 lecture notes" on Amazon) is just a website.
      const related = onPage && pageMatch(t, 40, state.lensPage, true);
      if (related && claudeAvailable()) return (await ask(`go to ${t}`)).speak;
      state.goal = null; // a new site: the open question is done
      return lensGo(await resolveSite(t));
    }
  }
  state.goal = null; // switching apps ends the open question too
  const r = await openApp(app ?? t);
  if (!r.ok) return lensGo(await resolveSite(t));
  state.lensActive = false;
  clearMenu('App');
  await new Promise((res) => setTimeout(res, 350));
  const front = await axFront().catch(() => null);
  if (front) state.prevFront = front;
  if (await bridgeActive()) {
    const s = await bridge.state();
    if (s.line) return `${r.name}, ${s.relPath}, ${speakLine(s.line, s.lineText ?? '')}`;
  }
  return `${r.name}${front?.title ? `, ${compact(shortTitle(front.title), 5)}` : ''}.`;
}

async function whereAmI(): Promise<string> {
  if (state.lensActive && state.lensPage) {
    const field = state.pendingInput ? ` Editing ${state.pendingInput.label}.` : '';
    return `${state.menu?.title ?? shortPageTitle(state.lensPage.title)}.${field}`;
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

/**
 * "The next post" / "the previous one": relative to the item last opened or heard. In a list
 * nyxOS knows, that's the neighbouring entry; otherwise Claude works it out from the page and
 * the conversation (which post was being discussed). Never a web lookup.
 */
async function relative(dir: 1 | -1, noun: string): Promise<string> {
  // A feed was read: go straight to the neighbouring post, wherever we are now (even inside a post).
  if (state.lensActive && state.feed && /post|one|item|story|article|video|thread|result/.test(noun)) {
    const onFeed = state.lensPage && state.lensPage.url === state.feed.url;
    const from = onFeed && state.lastPick == null ? 0 : state.feed.index;
    const next = state.feed.posts[from + dir];
    if (next) { state.feed.index = from + dir; state.lastPick = null; return lensGo(next.href); }
    return dir === 1 ? 'That was the last post I have from that feed.' : 'That was the first post.';
  }
  const m = state.menu;
  const base = heardItem() ?? state.lastPick;
  if (m && base != null && m.items[base - 1 + dir]) return choose(base + dir);
  if (claudeAvailable()) return (await ask(`${dir === 1 ? 'next' : 'previous'} ${noun}: open or read the ${noun} ${dir === 1 ? 'after' : 'before'} the one we were just discussing`)).speak;
  return `No ${dir === 1 ? 'next' : 'previous'} ${noun}.`;
}

async function choose(n: number): Promise<string> {
  const menu = state.menu;
  if (!menu) {
    if (state.lensActive && state.lensPage) return webView('outline').then(() => choose(n));
    return 'No list. Say windows.';
  }
  const item = menu.items[n - 1];
  if (!item) return `Only ${menu.items.length}.`;
  state.lastPick = n;
  return act(item.action, item.label);
}

async function act(a: Action, label: string): Promise<string> {
  switch (a.t) {
    case 'window': return focusWindow(a.w);
    case 'app': return appWindows(a.app, a.wins);
    case 'point': return reportClick(await rpc<ClickResult>('lens.clickPoint', { x: a.x, y: a.y, times: 1, until: '' }, 20000), '');
    case 'say': return a.text === '__lens' ? showLens() : a.text;
    case 'ax': {
      await toPrevApp();
      const r = await axPress(a.path);
      return r.ok ? `${label}.` : `Couldn't press ${label}.`;
    }
    case 'region': {
      const ids = new Set(a.item.children ?? []);
      const kids = (state.lensPage?.items ?? []).filter((i) => ids.has(i.id));
      return showMenu(regionName(a.item.label), 'Web', kids.map((k) => lensOption(k, false)));
    }
    case 'lens': return activateLens(a.item);
    case 'thread':
      state.replyTo = { handle: a.handle, name: a.name };
      return `${a.name}: ${a.text}.`;
  }
}

async function step(dir: 1 | -1): Promise<string> {
  // Paging through a long spoken list.
  if (state.menu && state.menu.items.length > MAX_SPOKEN_OPTIONS) {
    const m = state.menu;
    m.offset = Math.max(0, Math.min(m.items.length - 1, m.offset + dir * MAX_SPOKEN_OPTIONS));
    showOnPage(m.items.slice(m.offset, m.offset + MAX_SPOKEN_OPTIONS));
    return speakOptions(m.title, m.items, m.offset);
  }
  // Reading an article paragraph by paragraph, or comments one by one.
  if (state.lensActive && state.article.length) {
    if (dir === 1 && state.articleAt >= state.article.length - 1 && state.reading === 'comments') {
      // Out of loaded comments: scroll to load more, then continue.
      await rpc('lens.scrollBy', { direction: 'down', screens: 3 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 600));
      const more = commentLines(await refreshLens()).slice(state.article.length);
      if (!more.length) return 'No more comments.';
      state.article.push(...more);
    }
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
    return `Back to ${speakOptions(prev.title, prev.items, prev.offset)}`;
  }
  if (state.lensActive && state.lensPage) {
    if (state.history.length < 2) {
      // A page we didn't record (opened by the site itself): use the browser's own history.
      const before = state.lensPage.url;
      await rpc('lens.back', {}, 15000).catch(() => undefined);
      const page = await refreshLens();
      if (page.url === before) return `No earlier page. On ${shortPageTitle(page.title)}.`;
      state.history = [{ url: page.url, title: page.title }];
      return describe(page, undefined, 'Back to');
    }
    state.history.pop();
    const to = state.history[state.history.length - 1];
    return lensGo(to.url, undefined, 'Back to');
  }
  return listWindows();
}

// ------------------------------------------------------------------ typing & keys

async function typeInto(text: string): Promise<string> {
  if (state.lensActive && state.pendingInput) {
    const field = state.pendingInput;
    // Game inputs (a crossword's "2 down" entry) only respond to real keystrokes after being
    // selected; setting their value directly lands letters in the wrong cells.
    const gameEntry = /\b\d+\s*-?\s*(across|down)\b|\bcell\b|\bletter\b/i.test(field.label) || !/^(text|search|email|url|tel|textarea|number|password|)$/i.test(field.inputType ?? '');
    if (gameEntry) {
      const letters = text.replace(/[^a-z0-9]/gi, '');
      // A crossword entry's label gives its start square, length and direction
      // ("2-down: Convent dweller. 3 letters. at row 1, column 3"): type into exactly those squares.
      const geo = field.label.match(/(across|down)\b[\s\S]*?(\d+)\s*letters?[\s\S]*?row\s*(\d+),\s*column\s*(\d+)/i);
      if (geo) {
        const [, dir, len, row, col] = geo;
        const cells = Array.from({ length: Number(len) }, (_, i) => ({ x: Number(col) - 1 + (dir.toLowerCase() === 'across' ? i : 0), y: Number(row) - 1 + (dir.toLowerCase() === 'down' ? i : 0) }));
        if (letters.length !== cells.length) return `That's ${letters.length} letters; ${compact(field.label, 2)} needs ${len}.`;
        const typed = await rpc<number>('lens.typeCells', { cells, text: letters.toUpperCase() });
        if (typed === cells.length) {
          await new Promise((r) => setTimeout(r, 250));
          const before = state.lensPage;
          const page = await refreshLens();
          return `${letters.toUpperCase().split('').join(' ')} in ${compact(field.label, 2).replace(/:$/, '')}.${appeared(before, page)}`;
        }
      }
      if (field.inputType !== 'crossword') await rpc('lens.activate', { id: field.id, times: 1 }).catch(() => undefined);
      await rpc('lens.typeKeys', { text: letters, selectFirst: field.inputType === 'crossword' ? state.crosswordClue ?? undefined : undefined });
      await new Promise((r) => setTimeout(r, 300));
      const before = state.lensPage;
      const page = await refreshLens();
      return `Typed ${text} in ${compact(field.label, 3)}.${appeared(before, page)}`;
    }
    await rpc('lens.fill', { id: field.id, text });
    return `Typed ${text}.`;
  }
  // In the Lens with no field selected (a crossword, Wordle): type straight into the game.
  if (state.lensActive && state.lensPage) {
    await rpc('lens.typeKeys', { text });
    await new Promise((r) => setTimeout(r, 300));
    const page = await refreshLens();
    return `Typed ${text}.${appeared(state.lensPage, page)}`;
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
    if (keys === 'return' && !state.pendingInput && state.lensPage) {
      const btn = (await refreshLens()).items.find((i) => i.kind === 'button' && /^(submit|go|done|check|enter|next|continue|ok)$/i.test(i.label.trim()));
      if (btn) {
        const before = state.lensPage;
        // A real click: a game's Submit may ignore script-made clicks.
        const real = await rpc<{ found: boolean }>('lens.realClick', { id: btn.id }).catch(() => undefined);
        if (!real?.found) await rpc('lens.activate', { id: btn.id, times: 1 }, 20000).catch(() => undefined);
        // Games animate their verdict ("One away…", a solved group, a lost mistake): give it a moment.
        await new Promise((r) => setTimeout(r, 1600));
        const after = await refreshLens();
        const what = appeared(before, after).trim();
        return what ? `Submitted. ${what}` : 'Submitted. No change shown.';
      }
    }
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

async function click(target: string, times = 1): Promise<string> {
  const t = target.replace(/^((on|the|this|that|a|an|it|its)\s+)+/i, '').trim();
  const cw = await crosswordEntry(t);
  if (cw) return cw;
  const n = ordinal(target);
  if (n != null) return choose(n);
  // "click the item", "click it": refers to what was just discussed, which Claude can resolve.
  // "select those four", "click them", "select all of them": the words just spoken, matched to tiles.
  if (/^(those|these|them|those \w+|these \w+|all of them|all (four|three|five)|both|those words|the ones you said)$/i.test(t) && state.lensActive && state.lensPage) {
    const lastSaid = [...state.recent].reverse().find((l) => l.startsWith('nyx:'))?.slice(4) ?? '';
    const page = await refreshLens();
    const tiles = page.items.filter((i) => (i.kind === 'input' && (i.inputType === 'checkbox' || i.inputType === 'radio')) || i.kind === 'button');
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const said = ` ${norm(lastSaid)} `;
    const hits = tiles.filter((i) => i.label.trim().length > 1 && said.includes(` ${norm(i.label)} `));
    const uniq = [...new Map(hits.map((h) => [norm(h.label), h])).values()];
    if (uniq.length >= 2) {
      for (const h of uniq) await activateLens(h);
      return `Selected ${uniq.map((h) => compact(h.label, 3)).join(', ')}.`;
    }
  }
  const vague = !t || /^(it|this|that|one|item|thing|product|link|button|result|this one|that one)$/i.test(t);
  if (vague && heardItem()) return choose(heardItem()!);
  if (vague) return claudeAvailable() ? (await ask(`click ${target}`)).speak : 'Click what?';
  if (state.lensActive && state.lensPage) {
    const page = await refreshLens();
    const parts = t.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((p) => p.replace(/^(the|on)\s+/i, '').trim()).filter(Boolean);
    if (parts.length > 1) {
      const hits = parts.map((p) => pageMatch(p, 85, page));
      if (hits.every(Boolean)) {
        const said: string[] = [];
        for (const h of hits) said.push(await activateLens(h!));
        const sel = hits.map((h) => compact(h!.label, 3));
        return said.every((x) => x.startsWith('Selected')) ? `Selected ${sel.join(', ')}.` : said.join(' ');
      }
    }
    const m = menuIndex(t, 85);
    const fromMenu = m != null ? state.menu?.items[m - 1]?.action : undefined;
    if (fromMenu?.t === 'lens') return activateLens(fromMenu.item, times);
    if (m != null) return choose(m);
    const hit = pageMatch(t, 85, page);
    if (hit) return activateLens(hit, times);
    if (claudeAvailable()) return (await ask(`click ${target}${times > 1 ? ` ${times} times` : ''}`)).speak;
    return `Can't find ${t}.`;
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
  return `Can't find ${t}.`;
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
  if (state.lensActive && state.lensPage) return { speak: await describe(await refreshLens()) };
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
    return { speak: `${n.speak} ${items.map((it, i) => `${i + 1} ${it.label}`).join(', ')}.`, via: screen.via === 'gemini' ? 'gemini' : 'claude' };
  }
  return { speak: n.speak, via: 'claude' };
}

// ------------------------------------------------------------------ Lens browser

async function showLens(): Promise<string> {
  state.lensActive = true;
  setUi({ view: 'lens', level: 'Web' });
  if (!process.env.NYX_SCRIPT) { mainWin?.show(); mainWin?.focus(); }
  if (state.lensPage) return `Lens, ${shortPageTitle(state.lensPage.title)}.`;
  return 'Lens. Say search, or a website.';
}

/** Home: the transcript and shortcodes. The Lens keeps its page for "lens" to come back to. */
function showHome(): string {
  state.lensActive = false;
  setUi({ view: 'home', level: 'Home' });
  if (!process.env.NYX_SCRIPT) { mainWin?.show(); mainWin?.focus(); }
  return state.lensPage ? `Home. Say lens to go back to ${shortPageTitle(state.lensPage.title)}.` : 'Home.';
}

async function lensGo(url: string, title?: string, lead = ''): Promise<string> {
  await lensLoad(url);
  lastLoadFailed = loadFailed(state.lensPage!);
  if (lastLoadFailed) return `${lead ? `${lead} ` : ''}Couldn't load ${hostOf(url)}.`;
  notePage(state.lensPage!);
  return describe(state.lensPage!, title, lead);
}

/** Navigate the Lens and read the page, without describing it. */
async function lensLoad(url: string): Promise<void> {
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
    // Web apps and games show a loading screen after the document is ready: wait it out (up to ~5s).
    for (let i = 0; i < 6 && /\bloading\b|please wait/i.test(state.lensPage.article.slice(0, 600)); i++) {
      await new Promise((res) => setTimeout(res, 800));
      state.lensPage = await rpc<LensPage>('lens.extract', {});
    }
  }
}

let lastLoadFailed = false;
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const loadFailed = (p: LensPage) => /^chrome-error:|^about:blank/.test(p.url) || (p.items.length < 3 && /can.t be reached|took too long to respond|ERR_[A-Z_]+|not found on this server|DNS_PROBE/i.test(`${p.title} ${p.article.slice(0, 500)}`));

/**
 * The first thing said about a page. Search results, products and checkpoints have fast,
 * exact summaries; anything else gets Haiku's first glance (the top post, the score), which
 * is a second slower but says what a sighted person would actually notice first.
 */
const glanceCache = new Map<string, { g: Glance; at: number }>();

/** A fingerprint of what a page currently shows: the start of its text and its first items. */
function contentHash(page: LensPage): string {
  const sample = page.article.replace(/\s+/g, ' ').slice(0, 2000) + page.items.slice(0, 60).map((i) => i.label).join('|');
  let h = 5381;
  for (let i = 0; i < sample.length; i++) h = ((h * 33) ^ sample.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

let describingGame = false;

async function describe(page: LensPage, title?: string, lead = '', game = false): Promise<string> {
  const quick = summarizePage(page, title);
  describingGame = game;
  try {
    if (lead) return `${lead} ${await describeInner(page, title, quick, lead)}`;
    return describeInner(page, title, quick, '');
  } finally { describingGame = false; }
}

async function describeInner(page: LensPage, title: string | undefined, quick: string, lead: string): Promise<string> {
  const isSearch = /[?&](k|q|query|search|s|keywords?|field-keywords)=/i.test(page.url) && resultItems(page).length >= 3;
  const structured = page.items.some((i) => i.kind === 'result') || page.price || isSearch;
  if (structured || !claudeAvailable() || /wants you to confirm/.test(quick)) return quick;
  try {
    setUi({ status: 'thinking' });
    usedClaude = true;
    const goal = goalNow();
    const gen = cmdGen;
    let started = false;
    const say = (s: string) => { if (!started && lead) streamSentence(gen, lead); started = true; streamSentence(gen, s); };
    // The same page *content* again within 3 minutes: reuse its first look, no model call.
    // Keyed by what's on the page, not its address: Reddit's front page keeps its URL and title
    // while its posts change, and an old description would be wrong.
    const key = `${page.url}|${goal?.text ?? ''}|${contentHash(page)}`;
    const cached = glanceCache.get(key);
    // A page drawn on a canvas (a game) has little HTML to describe: look at it at the same time.
    const drawn = (page.canvas ?? 0) > 0.35 && page.items.filter((i) => i.kind === 'button' || i.kind === 'link').length < 15;
    const lookPromise = drawn && !cached ? detectOnScreenItems() : Promise.resolve([] as OptionItem<Action>[]);
    const g = cached && Date.now() - cached.at < 180_000 ? cached.g : await firstGlance((goal ? `User's open question (answer it only if this page does): "${goal.text}"\n\n` : '') + pageDigest(page), say);
    const seen = await lookPromise;
    if (seen.length) {
      showMenu(shortPageTitle(page.title), 'Web', seen, false);
      const line = `On screen: ${seen.slice(0, MAX_SPOKEN_OPTIONS).map((s) => s.say).join(', ')}.`;
      if (started) streamSentence(gen, line);
      glanceCache.set(`${page.url}|${goal?.text ?? ''}|${contentHash(page)}`, { g, at: Date.now() });
      return `${g.speak} ${line}`;
    }
    glanceCache.set(key, { g, at: Date.now() });
    if (glanceCache.size > 50) glanceCache.delete(glanceCache.keys().next().value!);
    if (g.look) describePictureNext(g.look);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    // Account chrome is never an option, whatever the model picked.
    const chrome = /\b(log ?in|sign ?(in|up)|subscribe|upgrade|account|menu|newsletter|get the app|download|got it|accept|agree|dismiss|cookie (banner|settings|preferences|policy|notice))\b/i;
    const opts = g.options.map((o) => ({ o, item: byId.get(o.id) })).filter((x) => x.item && !chrome.test(x.o.label) && !chrome.test(x.item.label));
    if (opts.length) showMenu(shortPageTitle(page.title), 'Web', opts.map(({ o, item }) => ({ ...lensOption(item!, false), say: o.label })), false);
    // The options are read out after the glance, unless the glance already listed them itself.
    const optionsLine = opts.length && !/\boptions?:/i.test(g.speak) ? `Options: ${opts.map(({ o }) => o.label).join(', ')}.` : '';
    if (started && optionsLine) streamSentence(gen, optionsLine);
    return optionsLine ? `${g.speak} ${optionsLine}` : g.speak;
  } catch {
    return quick;
  }
}

/**
 * After the first glance names an image post, describe its picture as a second, short
 * utterance: the glance isn't delayed, and the picture follows unless the user moves on.
 */
function describePictureNext(title: string) {
  const gen = cmdGen;
  void (async () => {
    try {
      const box = await rpc<{ x: number; y: number; width: number; height: number; media: boolean; text: string } | null>('lens.look', { text: title });
      if (!box?.media || gen !== cmdGen) return;
      await new Promise((r) => setTimeout(r, 250));
      const img = await captureLens(box, 768);
      if (!img || gen !== cmdGen) return;
      const line = await describeImage(img, box.text || title);
      // Wait for the glance to finish speaking; drop the picture if the user has moved on.
      for (let i = 0; i < 75 && (busy > 0 || ui.status === 'speaking'); i++) await new Promise((r) => setTimeout(r, 200));
      if (gen === cmdGen && busy === 0 && line) speak(line, { via: 'claude' });
    } catch { /* the picture is a bonus; never an error */ }
  })();
}

/** A compact text view of the page for Claude: title, the start of the main text, and items with ids. */
function pageDigest(page: LensPage): string {
  const line = (i: LensItem) => `${i.id} ${i.kind}: ${i.label.slice(0, 90)}${i.price ? ` (${i.price})` : ''}`;
  const items = page.items.filter((i) => i.kind !== 'region').slice(0, 120).map(line).join('\n');
  // What a sighted eye is drawn to first (SaIL-style salience), so the glance leads with it.
  const prominent = page.items.filter((i) => i.kind !== 'region' && (i.sal ?? 0) > 0).sort((a, b) => (b.sal ?? 0) - (a.sal ?? 0)).slice(0, 10).map(line).join('\n');
  const blocks = (page.blocks ?? []).slice(0, 4).map((b) => `${b.kind}${b.author ? ` by ${b.author}` : ''}${b.score ? ` (${b.score} points)` : ''}: ${b.text.slice(0, 300)}`).join('\n');
  const gameNote = describingGame ? 'The user just started this game. Describe the game state they need to play: the board, the clues (first across and down), the score, whose turn it is; then how to play by voice in one short clause (e.g. "say a clue number, then type the answer").\n' : '';
  return `${gameNote}Verbosity: ${ui.verbosity}\nPage: ${page.title}\nURL: ${page.url}\n${prominent ? `\nMost visually prominent:\n${prominent}\n` : ''}\nTop of the main text:\n${page.article.replace(/\s+/g, ' ').slice(0, 1800)}${blocks ? `\n\nPost and top comments:\n${blocks}` : ''}\n\nItems (id kind: label):\n${items}`;
}

/**
 * Screen recognition (Zhang et al., CHI 2021): find the clickable things by looking at the
 * screen, for pages whose controls are drawn (canvas games) or unlabeled. They become options
 * like any other: say their name or number.
 */
async function detectOnScreen(page: LensPage): Promise<string> {
  if (!claudeAvailable()) return 'Looking at the screen needs a Claude key.';
  usedClaude = true;
  setUi({ status: 'thinking' });
  const img = await captureLens();
  if (!img) return 'No page to look at.';
  const found = await detectElements(img, Math.round(lastCaptureSize.w), Math.round(lastCaptureSize.h));
  if (!found.length) return `Nothing clickable found on ${shortPageTitle(page.title)}.`;
  const items: OptionItem<Action>[] = found.map((d) => ({ label: d.label, detail: d.kind, say: compact(d.label, 4), action: { t: 'point', x: d.x * captureScale, y: d.y * captureScale, label: d.label } }));
  return showMenu(`On screen, by looking`, 'Web', items, true);
}

let lastCaptureSize = { w: 0, h: 0 };

async function detectOnScreenItems(): Promise<OptionItem<Action>[]> {
  try {
    const img = await captureLens();
    if (!img) return [];
    const found = await detectElements(img, Math.round(lastCaptureSize.w), Math.round(lastCaptureSize.h));
    return found.map((d) => ({ label: d.label, detail: d.kind, say: compact(d.label, 4), action: { t: 'point' as const, x: d.x * captureScale, y: d.y * captureScale, label: d.label } }));
  } catch { return []; }
}

/** CSS pixels per screenshot pixel, from the last capture (for web_click_point). */
let captureScale = 1;

/**
 * JPEG of the Lens page (or a rectangle of it, in CSS pixels), base64, for Claude to look at.
 * Kept under ~1 megapixel so the API doesn't downscale it: then the coordinates Claude reads
 * off the image are the ones we scale back to the page, and small images come back faster.
 */
async function captureLens(rect?: { x: number; y: number; width: number; height: number }, maxEdge = 1280, zoomOut = false): Promise<string | null> {
  const id = await rpc<number | null>('lens.capture', {});
  const wc = id != null ? webContents.fromId(id) : undefined;
  if (!wc) return null;
  // Page rectangles come in CSS pixels; the capture wants screen pixels, which differ by the zoom.
  const zoom = wc.getZoomFactor();
  const r = rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) } : undefined;
  // Zoomed out, the page lays out wider and shows about twice as much; restored right after.
  if (zoomOut) { wc.setZoomFactor(0.55); await new Promise((res) => setTimeout(res, 350)); }
  const img = r ? await wc.capturePage(r) : await wc.capturePage();
  if (zoomOut) { wc.setZoomFactor(zoom); captureScale = NaN; } // coordinates from a zoomed shot don't map back
  const { width: w, height: h } = img.getSize();
  const k = Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(1_000_000 / (w * h)));
  const sent = Math.max(1, Math.round(w * k));
  lastCaptureSize = { w: sent, h: Math.round(h * k) };
  if (!r && !zoomOut) {
    const cssWidth = Number(await wc.executeJavaScript('window.innerWidth')) || sent;
    captureScale = cssWidth / sent;
  }
  return img.resize({ width: sent }).toJPEG(70).toString('base64');
}

interface ClickResult { clicked: boolean; blocked?: boolean; times?: number; label?: string; reached?: boolean; found?: string; stopped?: boolean; textBefore?: string; textAfter?: string }

/** Buttons and fields that appeared after a same-page click, e.g. a confirm dialog's "Yes" and "No". */
function appeared(before: LensPage | null, after: LensPage): string {
  if (!before) return '';
  // Short new text first: a game's verdict ("One away..."), a toast ("Added to cart").
  const oldLines = new Set(before.article.split('\n').map((l) => l.trim()));
  // Readable lines only: no repeats, no run-together tile words ("CANDYSALADSPACE"), and blanks
  // ("___ BAR") spoken as "blank".
  const lines = [...new Set(after.article.split('\n').map((l) => l.trim())
    .filter((l) => l.length >= 3 && l.length <= 120 && !oldLines.has(l) && !/advertisement|sponsored/i.test(l) && !(l.length > 14 && !/\s/.test(l)) && !l.split(/\s+/).some((w) => w.length > 18))
    .map((l) => l.replace(/_{2,}/g, 'blank')))];
  // Drop a line that's already inside another ("KINDS OF STRIPS" vs "Correct group KINDS OF STRIPS").
  const said = lines.filter((l) => !lines.some((o) => o !== l && o.toLowerCase().includes(l.toLowerCase()))).slice(0, 3);
  const had = new Set(before.items.map((i) => `${i.kind}:${i.label}`));
  // Real controls only: one-letter labels are close boxes ("x") and icons, not news.
  const fresh = [...new Set(after.items.filter((i) => (i.kind === 'button' || i.kind === 'input' || i.kind === 'link') && i.label.trim().length > 2 && !had.has(`${i.kind}:${i.label}`)).map((i) => compact(i.label, 4)))].slice(0, 6);
  const sentences = said.map((l) => (/[.!?…]$/.test(l) ? l : `${l}.`)).join(' ');
  return `${sentences ? ` ${sentences}` : ''}${fresh.length ? ` New: ${fresh.join(', ')}.` : ''}`;
}

/** Spoken report for a free-form click, with the page title when it changed (a score, a count). */
async function reportClick(r: ClickResult | undefined, until: string): Promise<string> {
  if (r?.blocked) return `Something is covering the page${r.label ? `: ${compact(r.label, 6)}` : ''}. Close it or pick an option first.`;
  if (!r?.clicked) return 'Nothing there to click.';
  const before = state.lensPage;
  await new Promise((res) => setTimeout(res, /\d/.test(state.lensPage?.title ?? '') ? 1100 : 400));
  const page = await settleLens();
  // The click opened another page (a post, an article): describe it like any page you open.
  if (before && page.url !== before.url) {
    notePage(page);
    toolSpeechNext = true;
    return describe(page);
  }
  const times = r.times && r.times > 1 ? ` ${r.times} times` : '';
  const goal = until ? (r.reached ? ` ${compact(r.found || until, 8)}.` : r.stopped ? ' Stopped.' : ` No ${until} yet.`) : '';
  // A store item's own text changes when a purchase lands ("Cursor 35 6" → "Cursor 41 8"): say so.
  const changed = r.textAfter && r.textBefore !== r.textAfter ? ` ${compact(r.label ?? '', 3)} now shows ${r.textAfter.replace(/^\S+\s*/, '').slice(0, 40)}.` : '';
  return `Clicked ${compact(r.label ?? 'it', 5)}${times}.${goal}${changed} ${shortPageTitle(page.title)}.${appeared(before, page)}`;
}

function notePage(page: LensPage) {
  setTimeout(refreshBraille, 0);
  // A feed: remember its posts. A post from the remembered feed: remember which one is open.
  const samePost = (a: string, b: string) => a.replace(/[?#].*$/, '').replace(/\/$/, '') === b.replace(/[?#].*$/, '').replace(/\/$/, '');
  if ((page.posts?.length ?? 0) >= 3 && !(state.feed && state.feed.posts.some((p) => samePost(p.href, page.url)))) state.feed = { url: page.url, posts: page.posts!, index: 0 };
  else if (state.feed) {
    const i = state.feed.posts.findIndex((p) => samePost(p.href, page.url));
    if (i >= 0) state.feed.index = i;
  }
  const top = state.history[state.history.length - 1];
  if (top?.url !== page.url) state.history.push({ url: page.url, title: page.title });
  if (state.history.length > 50) state.history.shift();
}

/**
 * Open a game and start playing: press its own Play / Start / Continue button (only buttons
 * with those labels, never ads or Subscribe), wait for the board, then describe the game.
 */
async function playGame(url: string): Promise<string> {
  await lensLoad(url);
  // Press the game's own start-type buttons ("Play", "Continue to Connections", "Start game"),
  // never ads or subscribe, until the board is there: tiles, a grid, or a canvas (up to ~25s).
  const START = /^(play|play now|play (the )?(game|puzzle)|play \w+|start|start (the )?game|start playing|begin|let's play|continue|continue to \w+|continue to (the )?(game|puzzle)|resume|play without (an )?account|continue as guest|play as guest|no thanks,? (just )?play)$/i;
  const boardReady = (p: LensPage) => p.items.filter((i) => i.kind === 'input' && (i.inputType === 'checkbox' || i.inputType === 'radio' || /\b(across|down|cell|letter)\b/i.test(i.label))).length >= 4 || (p.canvas ?? 0) > 0.35;
  const t0 = Date.now();
  const pressed = new Set<string>();
  let idle = 0;
  while (Date.now() - t0 < 25_000) {
    const page = await refreshLens();
    if (boardReady(page)) break;
    // Already finished ("Nice work", "View results"), or nothing to press for a few seconds: stop waiting.
    if (/\b(nice work|puzzle (is )?(solved|complete)|you('ve)? (won|solved)|view results|come back tomorrow)\b/i.test(page.article.slice(0, 3000))) break;
    const start = page.items.find((it) => (it.kind === 'button' || it.kind === 'link') && START.test(it.label.trim()) && !/subscri|log ?in|sign ?up|upgrade|ad\b/i.test(it.label));
    idle = start ? 0 : idle + 1;
    if (idle >= 5 && Date.now() - t0 > 5000) break;
    if (start && !(pressed.has(start.label) && Date.now() - t0 < 4000)) {
      pressed.add(start.label);
      await rpc('lens.activate', { id: start.id, times: 1 }, 20000).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const page = await settleLens();
  notePage(page);
  glanceCache.clear();
  return describe(page, undefined, '', true);
}

async function refreshLens(): Promise<LensPage> {
  if (!ui.performance) state.lensPage = await rpc<LensPage>('lens.extract', {});
  return state.lensPage!;
}

/** After a click that starts loading inside the page (a game, an app view), wait for real content (up to ~8s). */
async function settleLens(): Promise<LensPage> {
  let page = await refreshLens();
  const loadingNow = (p: LensPage) => p.article.replace(/\s+/g, ' ').trim().length < 80 || /\bloading\b|please wait/i.test(p.article.slice(0, 400));
  for (let i = 0; i < 10 && loadingNow(page); i++) {
    await new Promise((r) => setTimeout(r, 800));
    page = await refreshLens();
  }
  return page;
}

function lensOption(i: LensItem, showKind = true): OptionItem<Action> {
  const kindWord: Record<string, string> = { link: 'link', button: 'button', input: 'field', heading: `heading ${i.level ?? ''}`.trim(), result: '', region: 'region', text: '' };
  // Speech names a field as a field (you type into it); other kinds stay on screen only.
  const say = i.kind === 'region' ? regionName(i.label) : i.kind === 'input' ? `${compact(i.label, 3)} field` : undefined;
  return { label: i.label, detail: (showKind && kindWord[i.kind]) || undefined, say, action: i.kind === 'region' ? { t: 'region', item: i } : { t: 'lens', item: i } };
}

/** "navigation: Primary" → "Primary nav", "main: Free shipping on…" → "Main", "complementary: Your recently viewed…" → "Your recently viewed". */
function regionName(label: string): string {
  const [role, ...rest] = label.split(': ');
  const name = compact(rest.join(': '), 3);
  switch (role) {
    case 'main': return 'Main';
    case 'banner': return 'Header';
    case 'footer': case 'contentinfo': return 'Footer';
    case 'search': return 'Search';
    case 'navigation': return name ? `${name} nav` : 'Nav';
    case 'form': return name ? `${name} form` : 'Form';
    case 'dialog': return name ? `Dialog, ${name}` : 'Dialog';
    default: return name || role;
  }
}

/** A link, button or field on the current Lens page that the utterance names. */
function pageMatch(text: string, min: number, page = state.lensPage, loose = false): LensItem | null {
  const items = (page?.items ?? []).filter((i) => i.kind === 'link' || i.kind === 'button' || i.kind === 'input' || i.kind === 'result');
  let best: LensItem | null = null, score = 0, near = 0;
  for (const i of items) {
    const sc = fuzzyScore(text, i.label);
    if (sc >= 70) near++;
    if (sc > score) { score = sc; best = i; }
  }
  if (text.trim().length <= 2) return null;
  if (loose) return score >= min ? best : null;
  // Exact or prefix match wins; a single-word partial match counts only when nothing else matches.
  return score >= min || (score >= 70 && near === 1) ? best : null;
}

/** Search the site you're on if it has a search box; otherwise (or when asked) the web. */
async function search(query: string, web = false): Promise<string> {
  const page = state.lensActive && state.lensPage && !web ? state.lensPage : null;
  const box = page && !ui.performance ? siteSearchBox(page) : null;
  if (box) {
    await rpc('lens.fill', { id: box.id, text: query }); // fill focuses the box, so return submits its form
    await rpc('lens.key', { key: 'return' }, 20000);
    const next = await refreshLens();
    notePage(next);
    return summarizeResults(next, `${shortPageTitle(page!.title)}, ${query}`) ?? summarizePage(next);
  }
  if (page && !web) {
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    if (!/duckduckgo/.test(host)) return lensGo(searchUrl(`site:${host} ${query}`), query);
  }
  return lensGo(searchUrl(query), query);
}

function siteSearchBox(page: LensPage): LensItem | null {
  const inputs = page.items.filter((i) => i.kind === 'input');
  const searchRegion = page.items.find((i) => i.kind === 'region' && /^search\b/i.test(i.label));
  return inputs.find((i) => /search|find|look ?up/i.test(i.label) || i.inputType === 'search')
    ?? inputs.find((i) => searchRegion?.children?.includes(i.id))
    ?? null;
}

/** After a site search: the main region's links are the results, spoken with prices when shown. */
function summarizeResults(page: LensPage, title: string): string | null {
  const results = resultItems(page);
  if (results.length < 3) return null;
  state.stack = [];
  return showMenu(title, 'Web', distinctSays(results.slice(0, 40).map(resultOption)), false);
}

/** "Nutricost Whey Protein Concentrate" ×3 → add words until each spoken name is different (sizes, flavors). */
function distinctSays(items: OptionItem<Action>[]): OptionItem<Action>[] {
  for (let words = 4; words <= 12; words += 2) {
    const name = (it: OptionItem<Action>) => compact(it.label.replace(/,/g, ''), words);
    const counts = new Map<string, number>();
    items.forEach((it) => counts.set(name(it), (counts.get(name(it)) ?? 0) + 1));
    items.forEach((it) => {
      if ((counts.get(name(it)) ?? 0) === 1 || words === 12 || it.say === undefined || !it.detail) return;
      it.say = `${compact(it.label.replace(/,/g, ''), words + 2)} ${it.detail}`;
    });
    if ([...counts.values()].every((c) => c === 1)) break;
  }
  return items;
}

/** The result list of a search page: one entry per product card, titled by its real name. */
function resultItems(page: LensPage): LensItem[] {
  const main = page.items.find((i) => i.kind === 'region' && /^main\b/i.test(i.label));
  const ids = new Set(main?.children ?? []);
  const chrome = /\bresults\b|^sponsored|^see (all|more)|^(previous|next)\b|^skip|^options:|^rated \d|^\d+(\.\d)? out of|^(more|other) (buying|sizes)|more colou?rs|new offers?|^amazon'?s? (saver|choice)|^best seller|^limited time/i;
  const priceLike = /^[\s$€£\d.,+()%-]+$|^\$/;
  const navIds = new Set(page.items.filter((i) => i.kind === 'region' && /^(navigation|banner|search|footer|contentinfo)\b/.test(i.label)).flatMap((r) => r.children ?? []));
  const candidate = (i: LensItem) => i.label.split(' ').length >= 3 && !chrome.test(i.label) && !priceLike.test(i.label) && !navIds.has(i.id);
  // Shopping pages: the results are the product cards that carry a price; each card has
  // several links (title, price, swatches), so keep the one with the longest real title.
  const priced = page.items.filter((i) => i.kind === 'link' && i.price && candidate(i));
  if (priced.length >= 3) {
    const byCard = new Map<string, LensItem>();
    for (const i of priced) {
      const key = i.card ?? i.id;
      const cur = byCard.get(key);
      if (!cur || i.label.length > cur.label.length) byCard.set(key, i);
    }
    const seen = new Set<string>();
    return [...byCard.values()].filter((i) => !seen.has(i.label) && seen.add(i.label));
  }
  // Links first: a product title appears as both a heading and its link.
  const results = page.items.filter((i) => (i.kind === 'link' || i.kind === 'heading') && (!main || ids.has(i.id)) && candidate(i))
    .sort((a, b) => Number(a.kind === 'heading') - Number(b.kind === 'heading'));
  const seen = new Set<string>();
  return results.filter((i) => !seen.has(i.label) && seen.add(i.label));
}

const priceValue = (p?: string) => (p ? Number(p.replace(/[^\d.]/g, '')) || NaN : NaN);

/** Narrow or sort the results already on screen (used when a site's own filters aren't usable). */
function filterResults(opts: { max?: number | null; min?: number | null; sort?: string | null; contains?: string | null }): string {
  if (!state.lensPage) return 'No results open.';
  let list = resultItems(state.lensPage);
  if (opts.max != null) list = list.filter((i) => priceValue(i.price) <= opts.max!);
  if (opts.min != null) list = list.filter((i) => priceValue(i.price) >= opts.min!);
  if (opts.contains) list = list.filter((i) => fuzzyScore(opts.contains!, i.label) >= 40);
  if (opts.sort === 'price_low') list = list.filter((i) => !isNaN(priceValue(i.price))).sort((a, b) => priceValue(a.price) - priceValue(b.price));
  if (opts.sort === 'price_high') list = list.filter((i) => !isNaN(priceValue(i.price))).sort((a, b) => priceValue(b.price) - priceValue(a.price));
  const what = [opts.max != null ? `under $${opts.max}` : '', opts.min != null ? `over $${opts.min}` : '', opts.sort === 'price_low' ? 'cheapest first' : opts.sort === 'price_high' ? 'priciest first' : ''].filter(Boolean).join(', ');
  if (!list.length) return `None ${what || 'match'} on this page.`;
  state.stack = [];
  return showMenu(`${list.length} ${what || 'matching'}`, 'Web', distinctSays(list.slice(0, 40).map(resultOption)), false);
}

function resultOption(i: LensItem): OptionItem<Action> {
  return { ...lensOption(i, false), detail: i.price, say: i.price ? `${compact(i.label, 4)} ${i.price}` : compact(i.label, 5) };
}

/** What a page is, in one breath: results, a product and its price, its regions, or its first controls. */
function summarizePage(page: LensPage, title?: string): string {
  const name = shortPageTitle(page.title);
  state.stack = [];
  // A site's "are you a person" step: say so and let the user press it. Never click it for them.
  const gate = page.items.find((i) => (i.kind === 'button' || i.kind === 'link') && /^continue( shopping)?$|i'?m not a robot|verify you are human/i.test(i.label));
  if (/\/checkpoint\/|captcha|\/challenge/i.test(page.url) || (gate && page.items.filter((i) => i.kind === 'link' && i.price).length === 0 && /continue/i.test(gate.label) && page.items.length < 120)) {
    if (gate) showMenu(name, 'Web', [lensOption(gate, false)], false);
    return `${name} wants you to confirm before continuing.${gate ? ` Say ${gate.label.toLowerCase()}.` : ''}`;
  }
  const results = page.items.filter((i) => i.kind === 'result');
  if (results.length) return showMenu(title ? `Results for ${title}` : name, 'Web', results.map(resultOption), false);
  if (/[?&](k|q|query|search|s|keywords?|field-keywords)=/i.test(page.url)) {
    const said = summarizeResults(page, `${name} results`);
    if (said) return said;
  }
  // One stop per distinct region name: Amazon has dozens of identical add-to-cart "form" regions.
  const seenRegion = new Set<string>();
  // Most visually prominent first (SaIL, IUI 2020): the region a sighted eye lands on leads.
  const regions = page.items.filter((i) => i.kind === 'region' && (i.children?.length ?? 0) > 0 && !/shortcut|skip|keyboard/i.test(i.label) && !seenRegion.has(i.label) && seenRegion.add(i.label))
    .sort((a, b) => (b.sal ?? 0) - (a.sal ?? 0));
  const regionItems = regions.map((r) => ({ ...lensOption(r), detail: regionDetail(r) }));
  if (page.price) {
    // Product page: name it by its main heading, then the price. Regions stay on screen.
    const h1 = page.items.find((i) => i.kind === 'heading' && i.level === 1)?.label ?? page.title;
    showMenu(name, 'Web', regionItems, false);
    return `${compact(h1, 7)}, ${page.price}.`;
  }
  if (regions.length > 1) return showMenu(name, 'Web', regionItems, false);
  const controls = page.items.filter((i) => i.kind === 'heading' || i.kind === 'link' || i.kind === 'button' || i.kind === 'input').slice(0, 40);
  if (controls.length) return showMenu(name, 'Web', controls.map((i) => lensOption(i, false)), false);
  clearMenu('Web');
  return `${name}.`;
}

function regionDetail(r: LensItem): string {
  const c = r.count;
  if (!c) return '';
  const n = (k: number, word: string) => k && `${k} ${word}${k === 1 ? '' : 's'}`;
  const parts = [n(c.headings, 'heading'), n(c.links, 'link'), n(c.inputs, 'field'), n(c.buttons, 'button')].filter(Boolean);
  return parts.join(', ');
}

async function webView(view: WebView, fresh = false): Promise<string> {
  if (!state.lensPage) return 'No page open.';
  state.lensActive = true;
  const page = fresh || !ui.performance ? await refreshLens() : state.lensPage;
  if (view === 'outline') return summarizePage(page);
  if (view === 'skim') {
    // Key sentences in order (Ahmed et al., UIST 2012); "next" continues with the full text.
    const s = skim(page.prose && page.prose.length > 300 ? page.prose : page.article, { brief: 0.08, normal: 0.15, detailed: 0.25 }[ui.verbosity], { brief: 2, normal: 3, detailed: 5 }[ui.verbosity], { brief: 4, normal: 7, detailed: 12 }[ui.verbosity]);
    if (!s.sentences.length) return 'Nothing to skim on this page.';
    state.article = page.article.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 30);
    state.articleAt = -1;
    state.reading = 'article';
    return `${shortPageTitle(page.title)}, skimmed: ${s.sentences.join(' ')} Say read article for all of it.`;
  }
  if (view === 'detect') return detectOnScreen(page);
  if (view === 'choices') {
    // A board of choices: checkbox/radio tiles (Connections), else the buttons in the main area.
    const ticks = page.items.filter((i) => i.kind === 'input' && (i.inputType === 'checkbox' || i.inputType === 'radio'));
    const navIds = new Set(page.items.filter((i) => i.kind === 'region' && /^(navigation|banner|footer|contentinfo)\b/.test(i.label)).flatMap((r) => r.children ?? []));
    const pool = ticks.length >= 4 ? ticks : page.items.filter((i) => i.kind === 'button' && !navIds.has(i.id) && !/^(shuffle|submit|deselect|menu|close|log ?in|share|settings|help)/i.test(i.label));
    if (!pool.length) return claudeAvailable() ? (await ask('what are the choices on this page?')).speak : 'No choices on this page.';
    const words = pool.map((i) => i.label.replace(/\s+/g, ' ').trim());
    // Read every word (a board is useless half-read); title-case shouting labels for speech.
    const say = words.map((w) => (w === w.toUpperCase() && w !== w.toLowerCase() ? w[0] + w.slice(1).toLowerCase() : w));
    showMenu(`${words.length} ${ticks.length >= 4 ? 'words' : 'choices'}`, 'Web', pool.map((i, n) => ({ ...lensOption(i, false), say: say[n] })), true);
    return `${words.length} ${ticks.length >= 4 ? 'words' : 'choices'}: ${say.join(', ')}.`;
  }
  if (view === 'comments') {
    state.article = commentLines(page);
    state.articleAt = 0;
    state.reading = 'comments';
    if (!state.article.length) return 'No comments on this page yet.';
    return `${state.article.length}${state.article.length >= 10 ? '+' : ''} comments. ${state.article[0]}`;
  }
  state.reading = 'article';
  if (view === 'article') {
    state.article = page.article.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 30);
    state.articleAt = 0;
    return state.article.length ? `${state.article.length} paragraphs. ${state.article[0]}` : 'No article text.';
  }
  const kinds = { headings: ['heading'], links: ['link', 'result'], forms: ['input'], buttons: ['button'] }[view];
  const items = page.items.filter((i) => kinds.includes(i.kind));
  return showMenu(view === 'forms' ? 'Form fields' : view[0].toUpperCase() + view.slice(1), 'Web', items.map((i) => lensOption(i, false)));
}

async function activateLens(item: LensItem, times = 1): Promise<string> {
  if (item.kind === 'input' && (item.inputType === 'checkbox' || item.inputType === 'radio')) {
    // A real click on the tile's label: games like Connections ignore script-made clicks.
    const tryClick = async (id: string) => {
      const r = await rpc<{ found: boolean; checked?: boolean | null }>('lens.realClick', { id }).catch(() => undefined);
      return r?.found ? r : await rpc<{ found: boolean; checked?: boolean }>('lens.activate', { id, times: 1 }).catch(() => undefined);
    };
    let r = await tryClick(item.id);
    if (!r?.found) {
      const again = (await refreshLens()).items.find((i) => i.kind === 'input' && i.label === item.label);
      if (!again) return `${compact(item.label, 4)} isn't on the page anymore.`;
      r = await tryClick(again.id);
    }
    return `${r?.checked ? 'Selected' : 'Unselected'} ${compact(item.label, 4)}.`;
  }
  if (item.kind === 'input') {
    state.pendingInput = item;
    if (!ui.performance) await rpc('lens.activate', { id: item.id });
    return `${compact(item.label, 4)} field.`;
  }
  if (item.kind === 'heading' && ui.performance) return `${item.label}.`;
  if (ui.performance || item.kind === 'result') {
    if (item.href) return lensGo(item.href);
  }
  const before = state.lensPage;
  if (item.kind === 'button' && times === 1) {
    const real = await rpc<{ found: boolean }>('lens.realClick', { id: item.id }).catch(() => undefined);
    if (real?.found) {
      await new Promise((res) => setTimeout(res, 600));
      const page = await settleLens();
      if (before && page.url !== before.url) { notePage(page); return describe(page); }
      return `Clicked ${compact(item.label, 4)}.${appeared(before, page)}`;
    }
  }
  let r = await rpc<{ navigated: boolean; found: boolean } | undefined>('lens.activate', { id: item.id, times }, 20000 + times * 400);
  if (r && !r.found) {
    // The page re-rendered (a game reloading, a single-page app): find the same thing again.
    const fresh = await refreshLens();
    const again = fresh.items.find((i) => i.kind === item.kind && i.label === item.label) ?? pageMatch(item.label, 85, fresh);
    if (!again) return `${compact(item.label, 4)} isn't on the page anymore.`;
    r = await rpc<{ navigated: boolean; found: boolean } | undefined>('lens.activate', { id: again.id, times }, 20000 + times * 400);
    if (r && !r.found) return `Couldn't click ${compact(item.label, 4)}.`;
  }
  // Games keep the score in the title and refresh it about once a second.
  if (!r?.navigated && /\d/.test(state.lensPage?.title ?? '')) await new Promise((res) => setTimeout(res, 1100));
  const page = await settleLens();
  if (r?.navigated) {
    notePage(page);
    return describe(page);
  }
  if (item.kind === 'heading') return `${item.label}.`;
  // Same page (a game, a toggle, add to cart): confirm, and say what the title now says (e.g. a score).
  const titleNow = shortPageTitle(page.title);
  const changed = titleNow !== shortPageTitle(state.history[state.history.length - 1]?.title ?? '');
  // Don't say the score twice: the title ("10 cookies") often also appears as new page text.
  const extra = appeared(before, page).replace(new RegExp(`\\s*${titleNow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'gi'), '');
  return `Clicked ${compact(item.label, 4)}${times > 1 ? ` ${times} times` : ''}.${changed ? ` ${titleNow}.` : ''}${extra}`;
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
  if (to && state.replyTo && to === state.replyTo.handle) target = state.replyTo;
  else if (to) {
    const threads = (state.menu?.items ?? []).filter((i) => i.action.t === 'thread');
    const hit = fuzzyPick(to, threads, (i) => i.label);
    if (hit) {
      const a = hit.action as Extract<Action, { t: 'thread' }>;
      target = { handle: a.handle, name: a.name };
    } else {
      target = { handle: to, name: to };
    }
  }
  if (!target) return 'Send to whom?';
  // A name, not a number or address: look it up in Contacts. Never send to a bare name.
  if (!isHandle(target.handle)) {
    const people = await findContacts(target.name);
    const withHandle = people.filter((p) => p.handles.length);
    if (!withHandle.length) return `No contact named ${target.name}.`;
    if (withHandle.length > 1) {
      const exact = withHandle.find((p) => p.name.toLowerCase() === target!.name.toLowerCase());
      if (!exact) return `Which one: ${withHandle.slice(0, 4).map((p) => p.name).join(', ')}?`;
      target = { handle: exact.handles[0], name: exact.name };
    } else target = { handle: withHandle[0].handles[0], name: withHandle[0].name };
  }
  if (!text.trim()) {
    state.compose = { to: target.handle };
    state.replyTo = target;
    return ui.discreet ? 'What should it say?' : `Message to ${target.name}. What should it say?`;
  }
  // Read it back first: speech-to-text can mishear, and a sent message can't be taken back.
  // Discreet mode doesn't say the name or text aloud (they're on screen and on the braille line).
  state.pendingSend = { handle: target.handle, name: target.name, text };
  return ui.discreet ? 'Message ready. Say yes to send, or change a word.' : `Send to ${target.name}: ${text}? Say yes to send, or change a word.`;
}

// ------------------------------------------------------------------ Claude operator

async function ask(text: string): Promise<Reply> {
  if (!claudeAvailable()) return { speak: 'Not a command. Say help.' };
  usedClaude = true;
  answering = GOAL.test(text.trim());
  if (answering) state.goal = { text, about: state.recent.filter((l) => l.startsWith('nyx:')).slice(-1)[0]?.slice(5, 400) ?? '', at: Date.now() };
  setUi({ status: 'thinking' });
  const front = await axFront().catch(() => null);
  const editor = (await bridgeActive()) ? await bridge.state().catch(() => null) : null;
  const context = [
    `Frontmost app: ${state.lensActive ? 'nyxOS Lens browser' : front?.app ?? 'unknown'}${front?.title ? ` — ${front.title}` : ''}`,
    state.lensActive && state.lensPage ? lensContext(state.lensPage) : '',
    editor?.line ? `Editor: ${editor.relPath} line ${editor.line} col ${editor.column}: ${editor.lineText}` : '',
    state.menu ? `Last spoken list "${state.menu.title}" (${state.menu.items.length} items): ${state.menu.items.slice(0, 40).map((it, i) => `${i + 1}. ${it.label.slice(0, 80)}${it.detail ? ` (${it.detail})` : ''}`).join('; ')}` : '',
    goalNow() && goalNow()!.text !== text ? `Open question the user is still trying to answer: "${goalNow()!.text}" (about: ${goalNow()!.about.slice(0, 200)}). If this step's result answers it, end with the answer.` : '',
    heard && Date.now() - heard.at < 30000 ? `The user interrupted the last reply right after hearing: "…${heard.text.slice(Math.max(0, heard.pos - 90), heard.pos)}". "That", "it", "this" most likely mean what was being said at that moment.` : '',
    `Verbosity: ${ui.verbosity}${ui.discreet ? '. Discreet mode: never say names, phone numbers, or message text aloud.' : ''}`,
    `Recent:\n${state.recent.slice(-8).join('\n')}`,
  ].filter(Boolean).join('\n');
  toolSpeech = null;
  const gen = cmdGen;
  const t0 = Date.now();
  let lastNudge = Date.now();
  const onStep = (name: string, ms?: number) => {
    log('system', `→ ${name}${ms != null ? ` ${ms}ms` : ''}`, 'claude');
    if (Date.now() - lastNudge > 12000 && gen === cmdGen) {
      lastNudge = Date.now();
      speak(Date.now() - t0 > 30000 ? 'Still on it.' : 'Still working.', { via: 'claude' });
    }
  };
  inOperator = true;
  const speakText = await operator(text, context, runTool, onStep, () => toolSpeech, () => gen !== cmdGen, (s) => streamSentence(gen, s, true))
    .finally(() => { inOperator = false; });
  return { speak: speakText, via: 'claude' };
}

function lensContext(page: LensPage): string {
  const box = siteSearchBox(page);
  const pick = (k: string, n: number) => page.items.filter((i) => i.kind === k).slice(0, n).map((i) => i.label.slice(0, 60)).join(' | ');
  return [
    `Lens page: ${page.title} (${page.url})`,
    state.history.length > 1 ? `Came from: ${state.history[state.history.length - 2].title} (${state.history[state.history.length - 2].url})` : '',
    page.price ? `Page price: ${page.price}` : '',
    `Site search box: ${box ? `yes ("${box.label}")` : 'no'}`,
    `Fields: ${page.items.filter((i) => i.kind === 'input' && i.inputType !== 'checkbox' && i.inputType !== 'radio').slice(0, 8).map((i) => i.label.slice(0, 60)).join(' | ') || 'none'}`,
    // Tiles and toggles (game boards, quizzes, filters): all of them, so most questions need no tool call.
    `Choices (checkboxes/radios, as id=label; select with web_activate on the id): ${page.items.filter((i) => i.kind === 'input' && (i.inputType === 'checkbox' || i.inputType === 'radio')).slice(0, 60).map((i) => `${i.id}=${i.label.slice(0, 40)}`).join(' | ') || 'none'}`,
    `Links: ${page.items.filter((i) => i.kind === 'link' || i.kind === 'result').slice(0, 30).map((i) => i.label.slice(0, 60) + (i.price ? ` (${i.price})` : '')).join(' | ') || 'none'}`,
    `Buttons: ${pick('button', 40) || 'none'}`,
  ].filter(Boolean).join('\n');
}

let agentWindows: WindowInfo[] = [];
/** Spoken result of a navigation tool; when set, it is the final answer (no extra Claude turn). */
let toolSpeech: string | null = null;
const FINAL_TOOLS = new Set(['focus_window', 'open_app', 'open_url', 'web_search', 'go_to_line', 'filter_results']);

let toolSpeechNext = false;
/** The current request is a question: navigation is a step toward the answer, never the answer. */
let answering = false;
const NAV_TOOLS = new Set(['open_url', 'web_search', 'site_search', 'focus_window', 'open_app']);

async function runTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  toolSpeechNext = false;
  const out = await runToolInner(name, input);
  if ((FINAL_TOOLS.has(name) || toolSpeechNext) && !(answering && NAV_TOOLS.has(name)) && typeof out === 'string') toolSpeech = out;
  return out;
}

async function runToolInner(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const gen0 = cmdGen;
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
    case 'open_url': {
      const u = s('url');
      const said = await lensGo(looksLikeUrl(u) ? normalizeUrl(u) : await resolveSite(u));
      return lastLoadFailed ? `${said} The address may be wrong: use web_search for the site instead of guessing another URL.` : said;
    }
    case 'web_search': return lensGo(searchUrl(s('query')), s('query'));
    case 'site_search': return search(s('query'));
    case 'web_outline': {
      const page = await refreshLens();
      const q = typeof input.query === 'string' ? input.query : '';
      // With a query: every item that mentions it (filters, sort menus, price fields), not just the first 150.
      const items = q ? page.items.filter((i) => i.kind !== 'region' && q.toLowerCase().split(/\s*\|\s*|\s+or\s+/).some((w) => i.label.toLowerCase().includes(w))).slice(0, 80) : page.items.slice(0, 150);
      return JSON.stringify({ title: page.title, url: page.url, price: page.price, items: items.map(({ id, kind, label, price, inputType }) => ({ id, kind, label, price, inputType })) });
    }
    case 'web_click_text': {
      const times = typeof input.times === 'number' ? input.times : 1;
      const until = typeof input.until === 'string' ? input.until : '';
      toolSpeechNext = times > 1 || Boolean(until); // a repeat/until click's report is the answer
      const r = await rpc<ClickResult>('lens.clickText', { text: s('text'), times, until }, 20000 + Math.max(times, until ? 100 : 0) * 400);
      // Only a click that landed ends the request; a miss lets Claude try another way.
      if (!r?.clicked) toolSpeechNext = false;
      return reportClick(r, until);
    }
    case 'web_click_point': {
      if (Number.isNaN(captureScale)) return 'Take a normal (not zoomed-out) web_screenshot first; zoomed-out coordinates do not map to the page.';
      const times = typeof input.times === 'number' ? input.times : 1;
      const until = typeof input.until === 'string' ? input.until : '';
      toolSpeechNext = times > 1 || Boolean(until);
      const r = await rpc<ClickResult>('lens.clickPoint', { x: n('x') * captureScale, y: n('y') * captureScale, times, until }, 20000 + Math.max(times, until ? 100 : 0) * 400);
      // Only a click that landed ends the request; a miss lets Claude try another way.
      if (!r?.clicked) toolSpeechNext = false;
      return reportClick(r, until);
    }
    case 'web_wait': {
      const appears = typeof input.appears === 'string' ? input.appears.toLowerCase() : '';
      const disappears = typeof input.disappears === 'string' ? input.disappears.toLowerCase() : '';
      const max = Math.min(45, typeof input.seconds === 'number' ? input.seconds : 20) * 1000;
      const t0 = Date.now();
      while (Date.now() - t0 < max) {
        const p = await refreshLens();
        const text = `${p.title} ${p.article} ${p.items.map((i) => i.label).join(' ')}`.toLowerCase();
        if ((!appears || text.includes(appears)) && (!disappears || !text.includes(disappears))) return `Ready after ${Math.round((Date.now() - t0) / 1000)}s.`;
        if (gen0 !== cmdGen) return 'Cancelled.';
        await new Promise((r) => setTimeout(r, 1000));
      }
      return `Still waiting after ${max / 1000}s.`;
    }
    case 'web_scroll': {
      const r = await rpc<{ y: number; max: number }>('lens.scrollBy', { direction: s('direction') === 'up' ? 'up' : 'down', screens: typeof input.screens === 'number' ? input.screens : 1 });
      await refreshLens();
      return r ? `Scrolled to ${r.max ? Math.round((100 * r.y) / r.max) : 0}% of the page${r.y >= r.max - 5 ? ' (the end)' : ''}.` : 'Scrolled.';
    }
    case 'web_hover': {
      const r = await rpc<{ label: string; tooltip: string } | null>('lens.hover', { text: typeof input.text === 'string' ? input.text : null, x: n('x') * captureScale || 0, y: n('y') * captureScale || 0 });
      return r ? (r.tooltip || r.label || 'Nothing new appeared.') : 'Nothing there to hover.';
    }
    case 'web_read_data': {
      // Read-only look at the page's own data (a game's state, a web app's model), where the
      // screen only shows icons. Refused on pages that handle sign-in or payment.
      const page = state.lensPage;
      if (!page) return 'No page open.';
      if (page.items.some((i) => i.inputType === 'password') || /bank|pay|checkout|wallet|login|signin|account/i.test(page.url)) return 'Not on sign-in or payment pages.';
      const code = s('expression');
      // Comparisons and arrow functions are fine; any other "=" is an assignment.
      const noCompare = code.replace(/===|!==|==|!=|<=|>=|=>/g, ' ');
      if (/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|eval|Function|import)\b|cookie|[lL]ocalStorage|sessionStorage|indexedDB|\.(submit|click|dispatchEvent|remove|append\w*|insert\w*|set\w*)\(|\+\+|--|=/.test(noCompare)) return 'Only read-only expressions are allowed: no assignments, clicks, storage or network.';
      try {
        const out = await rpc<unknown>('lens.eval', { code: `(() => { try { return JSON.stringify(${code}) ?? 'undefined'; } catch (e) { return 'Error: ' + e.message; } })()` }, 5000);
        return String(out).slice(0, 4000);
      } catch (e) { return `Error: ${(e as Error).message}`; }
    }
    case 'web_look': {
      // A cropped picture of one post/card: far smaller, so faster to read than a full screenshot.
      const box = await rpc<{ x: number; y: number; width: number; height: number; media: boolean; alt: string; text: string } | null>('lens.look', { text: s('text') });
      if (!box) return `Couldn't find "${s('text')}" on the page.`;
      await new Promise((res) => setTimeout(res, 250)); // let lazy images paint after scrolling
      const data = await captureLens(box, 768);
      const note = `${box.media ? 'Picture' : 'No picture; the post itself'}${box.alt ? `, alt text "${box.alt}"` : ''}. Post text: ${box.text}`;
      return data ? [{ type: 'text', text: note }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] : note;
    }
    case 'web_comments': {
      const page = await refreshLens();
      const lines = commentLines(page);
      const from = typeof input.from === 'number' ? input.from : 0;
      return lines.length ? lines.slice(from, from + 10).map((l, i) => `${from + i + 1}. ${l}`).join('\n') + (lines.length > from + 10 ? `\n(${lines.length - from - 10} more loaded)` : '') : 'No comments loaded; web_scroll down then try again.';
    }
    case 'web_select': {
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
      const page = await refreshLens();
      const set = ids.map((id) => page.items.find((i) => i.id === id)).filter(Boolean) as LensItem[];
      if (!set.length) return 'None of those ids are on the page; check the Choices list.';
      toolSpeechNext = true;
      return selectTiles(set, input.submit === true);
    }
    case 'web_type': {
      await rpc('lens.typeKeys', { text: s('text') });
      await new Promise((r) => setTimeout(r, 300));
      const before = state.lensPage;
      const page = await refreshLens();
      return `Typed. ${appeared(before, page)}`.trim();
    }
    case 'filter_results': {
      await refreshLens();
      const num = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : null);
      return filterResults({ max: num('max_price'), min: num('min_price'), sort: (input.sort as string) ?? null, contains: (input.contains as string) ?? null });
    }
    case 'web_find': {
      const hits = await rpc<string[]>('lens.find', { query: s('query') });
      return hits.length ? hits.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'Not found in page text. Try web_screenshot.';
    }
    case 'web_screenshot': {
      const data = await captureLens(undefined, 1280, input.zoom_out === true);
      return data ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }] : 'No page to capture.';
    }
    case 'web_activate': {
      const item = state.lensPage?.items.find((i) => i.id === s('id'));
      const times = typeof input.times === 'number' ? Math.max(1, Math.min(100, input.times)) : 1;
      if (item && times > 1) toolSpeechNext = true; // a repeat click's own report ("15 cookies") is the answer
      return item ? activateLens(item, times) : 'Unknown id; call web_outline.';
    }
    case 'web_fill': await rpc('lens.fill', { id: s('id'), text: s('text') }); return 'Filled.';
    case 'editor_state': return JSON.stringify(await bridge.state());
    case 'go_to_line': return speakLine(n('line'), (await goToLine(n('line'))).text);
    case 'read_lines': return (await bridge.lines(n('from'), n('to'))).map((l) => `${l.n}: ${l.text}`).join('\n');
    case 'diagnostics': return JSON.stringify(await bridge.diagnostics());
    case 'insert_text': await toPrevApp(); state.suppressFollowUntil = Date.now() + 1500; return `Inserted via ${await insertText(s('text'))}.`;
    case 'replace_line': await bridge.replaceLine(n('line'), s('text')); return `Line ${n('line')} replaced.`;
    case 'press_keys': return press(s('keys'));
    case 'read_screen': return state.lensActive && state.lensPage ? lensContext(await refreshLens()) : (await screenText()).text;
    case 'press_element': return (await axPress(s('path'))).ok ? 'Pressed.' : 'Press failed.';
    case 'unread_messages': {
      const msgs = await unreadMessages();
      const named = await Promise.all(msgs.map(async (m) => ({ ...m, name: await contactName(m.sender) })));
      return digest(named) || 'No unread messages.';
    }
    // Claude never sends directly: it sets up the same read-back-and-confirm as a spoken request.
    case 'send_message': toolSpeechNext = true; return reply(s('to'), s('text'));
  }
  return `Unknown tool ${name}`;
}

// ------------------------------------------------------------------ follow mode

let watchKey = '';
let watchLines = new Set<string>();
let lastAnnounce = 0;

/**
 * Watch mode: announce big changes the user didn't cause. In the Lens, the page reports
 * appended content (new messages, not tickers or counters). In other apps, new lines in the
 * front window's accessibility tree. Quiet for a few seconds after any command.
 */
let lastWatch = 0;

async function announceChanges(): Promise<boolean> {
  if (Date.now() - lastWatch < 2000 || busy > 0) return false;
  lastWatch = Date.now();
  const quiet = Date.now() - lastCommandAt < 4000 || Date.now() - lastAnnounce < 5000;
  let where = '', added: string[] = [];
  if (state.lensActive && state.lensPage) {
    added = (await rpc<string[]>('lens.changes', {}, 3000).catch(() => [])) ?? [];
    where = shortPageTitle(state.lensPage.title);
  } else {
    const tree = await axTree(12, 300).catch(() => null);
    if (!tree) return false;
    const key = `${tree.app}|${tree.title}`;
    const lines = treeToText(tree.tree).split('\n').map((l) => l.replace(/\{[\d.]+\}/g, '').trim()).filter((l) => l.length >= 12);
    const fresh = key === watchKey ? lines.filter((l) => !watchLines.has(l)) : [];
    if (key !== watchKey) { watchKey = key; watchLines = new Set(lines); return false; }
    lines.forEach((l) => watchLines.add(l));
    // A whole new screen (navigation) is the user's doing, not news.
    if (fresh.length > 12) return false;
    added = fresh;
    where = tree.app;
  }
  const text = added.join('\n').trim();
  if (quiet || text.length < 25) return false;
  lastAnnounce = Date.now();
  // Short news is read as is (word-capped, never cut at a comma); long bursts get a one-line summary.
  const words = text.replace(/\s+/g, ' ').split(' ');
  // Haiku phrases it like a person would (and drops repeats of what was just said); without a key, read it as is.
  let line = claudeAvailable() ? await summarizeChange(where, text, state.recent.slice(-4).join('\n')) : `New: ${words.slice(0, 30).join(' ')}${words.length > 30 ? '…' : ''}`;
  if (/^skip\b/i.test(line.trim())) return false;
  if (!line.trim()) return false;
  speak(line, { via: 'follow' });
  return true;
}

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
      // Something new on screen the user didn't ask for (a chat message, a notification).
      if (await announceChanges()) return;
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

/** Warm Claude's caches now and every 50 minutes (they live an hour), and pre-make common speech. */
export function startWarmers() {
  void warmCaches();
  setInterval(() => void warmCaches(), 50 * 60_000);
  // One at a time, in the background: never compete with the user's first command for the voice API.
  // Never in test runs: they're muted, and each launch would spend voice credits for nothing.
  if (process.env.NYX_SCRIPT || process.env.NYX_MUTE) return;
  void (async () => {
    for (const line of ['Still working.', 'Still on it.', 'Not sent.', 'Heard no words.', "Didn't catch that.", 'No earlier page.', 'Done.']) {
      await synthesizeCached(line, ui.rate).catch(() => undefined);
    }
  })();
}

export function shortcodeHelp(): Array<[string, string]> {
  return SHORTCODES;
}
