// The nyxOS command grammar.
//
// Philosophy: the user drives. These are the *steps* a sighted person takes with
// mouse and keyboard ("open this", "go to line 42", "type this"), not delegated
// goals ("go build me a website"). Anything that matches here runs instantly with
// no LLM round-trip; everything else falls through to Claude as `ask`.
//
// Accuracy beats speed: a rule belongs here only if the phrase has one meaning.
// Anything that needs judgment ("find the cheapest one", "protein powder under
// $20") is left to Claude, even though it is a few seconds slower.
//
// Two input dialects map onto the same Command type:
//   voice  — natural phrases from speech-to-text ("go to line forty two")
//   typed  — ultra-short touch-typing codes ("g 42"), see SHORTCODES below

export type WebView = 'outline' | 'headings' | 'links' | 'forms' | 'buttons' | 'article' | 'comments' | 'choices' | 'skim' | 'detect';

export type Command =
  | { kind: 'windows' }
  | { kind: 'choose'; index: number }
  | { kind: 'open'; target: string; play?: boolean }
  | { kind: 'goToLine'; line: number }
  | { kind: 'type'; text: string }
  | { kind: 'code'; spoken: string }
  | { kind: 'press'; keys: string }
  | { kind: 'readLine'; count?: number }
  | { kind: 'readScreen'; goal?: string }
  | { kind: 'whereAmI' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'back' }
  | { kind: 'repeat' }
  | { kind: 'stop' }
  | { kind: 'search'; query: string; web?: boolean; qualified?: boolean }
  | { kind: 'web'; view: WebView; more?: boolean }
  | { kind: 'click'; target: string; times?: number; submit?: boolean }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'unread' }
  | { kind: 'reply'; to?: string; text: string }
  | { kind: 'rate'; delta: number }
  | { kind: 'curtain'; on: boolean }
  | { kind: 'performance'; on: boolean }
  | { kind: 'follow'; on: boolean }
  | { kind: 'help' }
  | { kind: 'voice'; provider: 'cartesia' | 'elevenlabs' | 'next' }
  | { kind: 'relative'; dir: 1 | -1; noun: string }
  | { kind: 'verbosity'; level: 'brief' | 'normal' | 'detailed' }
  | { kind: 'discreet'; on: boolean }
  | { kind: 'ask'; text: string };

export type Source = 'voice' | 'typed';

export const SHORTCODES: Array<[string, string]> = [
  ['w', 'list windows'],
  ['1-9', 'choose option'],
  ['o <app|url>', 'open'],
  ['g <n>', 'go to line'],
  ['t <text>', 'type text'],
  ['c <spoken code>', 'type code (Claude formats it)'],
  ['k <keys>', 'press keys, e.g. k cmd+s'],
  ['l [n]', 'read current line (or n lines)'],
  ['r', 'read screen'],
  ['?', 'where am I'],
  ['n / p', 'next / previous'],
  ['b', 'back up one level'],
  ['s <query>', 'search this site (or the web)'],
  ['h / a / f', 'headings / links / form fields'],
  ['u', 'unread messages'],
  ['m <name>: <text>', 'message someone'],
  ['.', 'repeat last'],
  ['x', 'stop talking'],
  ['+ / -', 'speak faster / slower'],
  ['/ <anything>', 'ask Claude'],
];

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
  six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "forty two" → 42, "one hundred and five" → 105, "42" → 42. Returns null if not a number. */
export function parseNumber(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/-/g, ' ').replace(/,/g, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const words = s.split(/\s+/).filter((w) => w && w !== 'and');
  if (!words.length) return null;
  // Digit-by-digit dictation: "four two" → 42
  if (words.length > 1 && words.every((w) => w in SMALL && SMALL[w] < 10)) {
    return parseInt(words.map((w) => SMALL[w]).join(''), 10);
  }
  let total = 0, current = 0;
  for (const w of words) {
    if (w in SMALL) current += SMALL[w];
    else if (w in TENS) current += TENS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else if (/^\d+$/.test(w)) current += parseInt(w, 10);
    else return null;
  }
  return total + current;
}

const KEY_ALIASES: Record<string, string> = {
  command: 'cmd', cmd: 'cmd', '⌘': 'cmd', super: 'cmd', meta: 'cmd',
  control: 'ctrl', ctrl: 'ctrl', ctl: 'ctrl',
  option: 'alt', opt: 'alt', alt: 'alt',
  shift: 'shift',
  enter: 'return', return: 'return', escape: 'escape', esc: 'escape', tab: 'tab', space: 'space',
  backspace: 'delete', delete: 'delete', 'forward delete': 'forwarddelete',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', 'page up': 'pageup', 'page down': 'pagedown',
};

/** "command shift p" / "cmd+shift+p" / "Control G" → "cmd+shift+p" */
export function normalizeKeys(input: string): string {
  const s = input.toLowerCase().replace(/\b(key|keys|button)\b/g, '').trim();
  const parts = s.split(/[\s+\-]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const two = parts[i] + ' ' + (parts[i + 1] ?? '');
    if (KEY_ALIASES[two]) { out.push(KEY_ALIASES[two]); i++; continue; }
    out.push(KEY_ALIASES[parts[i]] ?? parts[i]);
  }
  return out.join('+');
}

const NAMED_KEYS: Record<string, string> = {
  save: 'cmd+s', undo: 'cmd+z', redo: 'cmd+shift+z', copy: 'cmd+c', paste: 'cmd+v', cut: 'cmd+x',
  'select all': 'cmd+a', enter: 'return', return: 'return', submit: 'return', 'new line': 'return',
  escape: 'escape', cancel: 'escape', tab: 'tab', 'close tab': 'cmd+w', 'close window': 'cmd+w',
  'new tab': 'cmd+t', 'new file': 'cmd+n', find: 'cmd+f', backspace: 'delete', 'delete that': 'delete',
  'command palette': 'cmd+shift+p', quit: 'cmd+q',
};

function clean(text: string): string {
  return text.trim().replace(/^[\s"'“”]+|[\s"'“”.!?,]+$/g, '');
}

/** Strip polite filler STT likes to include: "can you please open safari" → "open safari" */
function stripFiller(s: string): string {
  return s
    .replace(/^(hey|ok|okay|um|uh|so|now|and|then|no|yes|yeah|wait|alright)[,.]? +/g, '')
    .replace(/^(hey|ok|okay|um|uh|so|now|and|then|no|yes|yeah|wait|alright)[,.]? +/g, '')
    .replace(/^((hey )?(nyx|nix|nicks|nyx os|nyxos|callbacks),? )/g, '')
    .replace(/^(can you |could you |would you |please |i want to |i'd like to |let's |lets )+/g, '')
    .replace(/ please$/g, '')
    .trim();
}

const SYMBOL_CODES: Record<string, Command> = {
  '?': { kind: 'whereAmI' }, '.': { kind: 'repeat' }, '+': { kind: 'rate', delta: 0.25 }, '-': { kind: 'rate', delta: -0.25 },
};

export function parseCommand(raw: string, source: Source = 'voice'): Command | null {
  if (source === 'typed' && SYMBOL_CODES[raw.trim()]) return SYMBOL_CODES[raw.trim()];
  const text = clean(raw);
  if (!text) return null;
  if (source === 'typed') {
    const typed = parseTyped(text);
    if (typed) return typed;
  }
  return parseVoice(text);
}

function parseTyped(text: string): Command | null {
  if (text.startsWith('/')) return { kind: 'ask', text: text.slice(1).trim() };
  if (/^[1-9]\d?$/.test(text)) return { kind: 'choose', index: parseInt(text, 10) };
  const m = text.match(/^(\S)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, code, rest = ''] = m;
  const arg = rest.trim();
  switch (code) {
    case 'w': return arg ? null : { kind: 'windows' };
    case 'o': return arg ? { kind: 'open', target: arg } : null;
    case 'g': { const n = parseNumber(arg); return n != null ? { kind: 'goToLine', line: n } : null; }
    case 't': return arg ? { kind: 'type', text: rest } : null;
    case 'c': return arg ? { kind: 'code', spoken: arg } : null;
    case 'k': return arg ? { kind: 'press', keys: normalizeKeys(arg) } : null;
    case 'l': return { kind: 'readLine', count: arg ? parseNumber(arg) ?? 1 : 1 };
    case 'r': return { kind: 'readScreen', goal: arg || undefined };
    case '?': return { kind: 'whereAmI' };
    case 'n': return arg ? null : { kind: 'next' };
    case 'p': return arg ? null : { kind: 'previous' };
    case 'b': return arg ? null : { kind: 'back' };
    case 's': return arg ? { kind: 'search', query: arg } : null;
    case 'h': return { kind: 'web', view: 'headings' };
    case 'a': return { kind: 'web', view: 'links' };
    case 'f': return { kind: 'web', view: 'forms' };
    case 'u': return { kind: 'unread' };
    case 'm': {
      const mm = arg.match(/^([^:]+):\s*([\s\S]+)$/);
      // "m Sam: on my way" sends; "m Sam" (a name, no colon) starts a message to Sam.
      if (mm) return { kind: 'reply', to: mm[1].trim(), text: mm[2] };
      return arg ? { kind: 'reply', to: arg, text: '' } : null;
    }
    case '.': return { kind: 'repeat' };
    case 'x': return { kind: 'stop' };
    case '+': return { kind: 'rate', delta: 0.25 };
    case '-': return { kind: 'rate', delta: -0.25 };
  }
  return null;
}

type Rule = [RegExp, (m: RegExpMatchArray, original: string) => Command | null];

/** Words that turn a search into a judgment call: filters, rankings, comparisons. */
const QUALIFIED = /\b(under|below|over|above|less than|more than|cheaper|cheapest|priciest|most expensive|best|top|highest|lowest|rated|stars?|between|within|sort|filter|only|without|compare|vs|versus|deal|discount|on sale)\b|[$€£]|\bdollars?\b/;

// Order matters: specific before general.
const VOICE_RULES: Rule[] = [
  [/^(stop|quiet|shut up|shh+|silence|be quiet)$/, () => ({ kind: 'stop' })],
  [/^(repeat( that)?|say (that|it) again|what( did you say)?)$/, () => ({ kind: 'repeat' })],
  [/^(help|what can i (say|do)|commands)$/, () => ({ kind: 'help' })],
  [/^(where am i|what('s| is) (focused|selected)|status)$/, () => ({ kind: 'whereAmI' })],
  [/^(speak |talk |read )?(faster|speed up)$/, () => ({ kind: 'rate', delta: 0.25 })],
  [/^(speak |talk |read )?(slower|slow down)$/, () => ({ kind: 'rate', delta: -0.25 })],
  [/^(screen curtain|curtain|screen) (on|off)$/, (m) => ({ kind: 'curtain', on: m[1] === 'screen' ? m[2] === 'off' : m[2] === 'on' })],
  [/^(turn (off|on) (the )?screen)$/, (m) => ({ kind: 'curtain', on: m[2] === 'off' })],
  [/^(performance|battery|low power|fast) mode( (on|off))?$/, (m) => ({ kind: 'performance', on: m[3] !== 'off' })],
  [/^(follow|echo) mode( (on|off))?$/, (m) => ({ kind: 'follow', on: m[3] !== 'off' })],
  // Ahmed et al. (UIST 2012): skim a page instead of hearing all of it.
  [/^(?:skim|skim (?:this|the) (?:page|article|post|story)|give me the gist|what's the gist|the gist|summari[sz]e (?:this|the) (?:page|article))$/, () => ({ kind: 'web', view: 'skim' })],
  // Zhang et al. (CHI 2021): find controls from pixels where the page has no labels.
  [/^(?:what can i (?:click|press|tap)|find (?:the )?(?:buttons|controls)(?: on (?:the )?screen)?|look for buttons|detect (?:the )?(?:buttons|controls))$/, () => ({ kind: 'web', view: 'detect' })],
  // Abdolrahmani et al. (ASSETS 2018): users want control over how much is said, and privacy.
  [/^(?:be brief|brief mode|talk less|shorter answers|less detail|be quiet(?:er)?|terse mode)$/, () => ({ kind: 'verbosity', level: 'brief' })],
  [/^(?:detailed mode|be detailed|talk more|longer answers|more detail(?:s)? (?:mode|from now on)|verbose mode)$/, () => ({ kind: 'verbosity', level: 'detailed' })],
  [/^(?:normal mode|normal detail|normal verbosity)$/, () => ({ kind: 'verbosity', level: 'normal' })],
  [/^(?:discreet|private|privacy) mode( (on|off))?$/, (m) => ({ kind: 'discreet', on: m[2] !== 'off' })],
  [/^(?:use|switch to|change to) (?:the )?(eleven ?labs|cartesia)(?: voice)?$/, (m) => ({ kind: 'voice', provider: m[1].startsWith('eleven') ? 'elevenlabs' : 'cartesia' })],
  [/^(?:switch|change|swap|toggle) (?:the )?voice(?: provider)?$/, () => ({ kind: 'voice', provider: 'next' })],
  [/^(go back to |back to |show |list |switch )?(the )?(windows|window list|apps|app switcher)$/, () => ({ kind: 'windows' })],
  [/^(switch windows|switch apps|what('s| is) open)$/, () => ({ kind: 'windows' })],
  [/^(go |jump |move )?(back|up)( a level| one level)?$/, () => ({ kind: 'back' })],
  [/^(?:read |show |open |go to |show me |see |view )?(?:the )?(?:top )?comments$/, () => ({ kind: 'web', view: 'comments' })],
  // "show me more comments", "read the rest of the comments": continue reading comments.
  [/^(?:show(?: me)?|read(?: me)?|give me|load|see|get|tell me|what are|more)? ?(?:the )?(?:more|other|rest of the|all the|next|remaining|some more) comments$/, () => ({ kind: 'web', view: 'comments', more: true })],
  // "What are the words?" on a game board, "what are my options" on a quiz: read the choices, no model call.
  [/^(?:what are|what're|read(?: out)?|list|tell me)(?: me)?(?: all)? (?:the |my )?(?:words|tiles|choices|options|cards|answers|squares)(?: for me)?(?: on (?:the|this) (?:page|board|screen))?$/, () => ({ kind: 'web', view: 'choices' })],
  [/^(next|next one|down|next comment|read next comment|next reply)$/, () => ({ kind: 'next' })],
  // "go to the next post", "open the previous one": relative to what's being discussed, never a website.
  [/^(?:go to |open |show me |read |play |what's |what is |click(?: on)? )?(?:the )?(next|previous|prior|last) (post|one|item|result|article|story|video|product|thread|page|link|option|answer|song|episode|clue|word|comment)$/, (m) => ({ kind: 'relative', dir: m[1] === 'next' ? 1 : -1, noun: m[2] })],
  [/^(previous comment|last comment|previous reply)$/, () => ({ kind: 'previous' })],
  [/^(previous|prev|last one|go previous)$/, () => ({ kind: 'previous' })],
  [/^(?:choose |pick |select |option |number |open |go to )?(?:number |option )?(\w+(?: \w+)?)$/, (m) => {
    const n = parseNumber(m[1]);
    return n != null && n >= 1 && n <= 99 ? { kind: 'choose', index: n } : null;
  }],
  [/^(?:go to|jump to|goto) line (.+)$/, (m) => { const n = parseNumber(m[1]); return n != null ? { kind: 'goToLine', line: n } : null; }],
  [/^line (.+)$/, (m) => { const n = parseNumber(m[1]); return n != null ? { kind: 'goToLine', line: n } : null; }],
  [/^(?:read|what's on|what is on) (?:the )?(?:current |this )?line$/, () => ({ kind: 'readLine', count: 1 })],
  [/^read (?:the )?(?:next )?(.+) lines$/, (m) => ({ kind: 'readLine', count: parseNumber(m[1]) ?? 5 })],
  [/^(?:read|describe|what's on|what is on) (?:the )?screen(?: for (.+))?$/, (m) => ({ kind: 'readScreen', goal: m[1] })],
  [/^(?:look around|what do you see|what's here|what is here)$/, () => ({ kind: 'readScreen' })],
  [/^(?:read|check) (?:my )?(?:unread|new) (?:messages|texts)$|^(?:any )?(?:unread|new) messages$|^unread$/, () => ({ kind: 'unread' })],
  [/^(?:reply|respond)(?: to (.+?))?(?: saying|:| with)? (.+)$/, (m, o) => ({ kind: 'reply', to: m[1], text: tail(o, m[2]) })],
  [/^(?:text|message|send a message to|tell) (.+?)(?: saying|:| that) ["“]?(.+)$/, (m, o) => ({ kind: 'reply', to: m[1], text: tail(o, m[2]) })],
  [/^(?:text|message|send a message to|write to) (\w+(?: \w+)?)$/, (m, o) => ({ kind: 'reply', to: tail(o, m[1]), text: '' })],
  [/^(?:show |list |read )?(?:the )?headings$/, () => ({ kind: 'web', view: 'headings' })],
  [/^(?:show |list |read )?(?:the )?links$/, () => ({ kind: 'web', view: 'links' })],
  [/^(?:show |list |read )?(?:the )?(?:form|forms|fields|inputs|text fields)$/, () => ({ kind: 'web', view: 'forms' })],
  [/^(?:show |list |read )?(?:the )?buttons$/, () => ({ kind: 'web', view: 'buttons' })],
  [/^(?:read (?:the )?(?:article|page|main content)|read it)$/, () => ({ kind: 'web', view: 'article' })],
  [/^(?:outline|overview|page outline|regions|landmarks)$/, () => ({ kind: 'web', view: 'outline' })],
  // "search X" searches the site you're on when it has a search box; "google X" always means the web.
  // A query with conditions (price, ranking, sorting) is flagged: on a site, Claude searches then filters.
  [/^(?:google|search the web for|search the web|web search|search online for|search google for) (.+)$/, (m, o) => ({ kind: 'search', query: tail(o, m[1]), web: true })],
  [/^(?:search for|search|look up) (.+)$/, (m, o) => (QUALIFIED.test(m[1]) ? { kind: 'search', query: tail(o, m[1]), qualified: true } : { kind: 'search', query: tail(o, m[1]) })],
  [/^scroll (up|down)$/, (m) => ({ kind: 'scroll', direction: m[1] as 'up' | 'down' })],
  // "quick" and "clique" are how speech-to-text often hears "click".
  [/^(?:click|quick|clique|klick|press|tap|activate|hit) (?:on )?(?:the )?(.+) (\d+|\w+) times$/, (m) => {
    const n = parseNumber(m[2]);
    return n != null && n > 0 ? { kind: 'click', target: m[1], times: Math.min(100, n) } : null;
  }],
  // "select those four and submit", "submit those four", "select the last four, then submit".
  [/^(?:select|choose|pick|click) (.+?),? (?:and |then |and then )submit(?: (?:it|them|those))?$/, (m) => ({ kind: 'click', target: m[1], submit: true })],
  [/^submit (?:those|these|the) (?:\w+ )?(?:four|three|words|ones|tiles|last four|remaining four)$|^submit (?:the )?(?:last|remaining) (?:four|ones)$/, (m) => ({ kind: 'click', target: m[0].replace(/^submit\s+/, ''), submit: true })],
  [/^(?:buy|select|choose) (?:a |an |the |one )?(.+)$/, (m) => ({ kind: 'click', target: m[1] })],
  [/^(?:click|clique|klick|press|tap|activate) (?:on )?(?:the )?(.+?)(?: button| link)?$/, (m) => {
    const keyish = NAMED_KEYS[m[1]] ?? (/^(cmd|command|control|ctrl|option|alt|shift)\b/.test(m[1]) ? normalizeKeys(m[1]) : null);
    if (keyish) return { kind: 'press', keys: keyish };
    return { kind: 'click', target: m[1] };
  }],
  [/^(?:hit|press|key|shortcut) (.+)$/, (m) => ({ kind: 'press', keys: NAMED_KEYS[m[1]] ?? normalizeKeys(m[1]) })],
  [/^(?:type|write|enter|dictate|insert) (?:code|the code) (.+)$/, (m, o) => ({ kind: 'code', spoken: tail(o, m[1]) })],
  [/^code (.+)$/, (m, o) => ({ kind: 'code', spoken: tail(o, m[1]) })],
  [/^(?:type|write|dictate|insert) (.+)$/, (m, o) => ({ kind: 'type', text: tail(o, m[1]) })],
  [/^(?:play|let's play|start playing|start a game of|i want to play) (?:a |an |the |some )?(.+)$/, (m) => ({ kind: 'open', target: m[1], play: true })],
  [/^(?:open|launch|start|switch to|go to|focus|show me|bring up|pull up) (.+)$/, (m) => ({ kind: 'open', target: m[1] })],
];

/** Recover the original-case text for free-text captures (we matched on lowercase). */
function tail(original: string, lowerCapture: string): string {
  const idx = original.toLowerCase().lastIndexOf(lowerCapture);
  return idx >= 0 ? original.slice(idx, idx + lowerCapture.length) : lowerCapture;
}

function parseVoice(text: string): Command | null {
  const original = text;
  const lower = stripFiller(text.toLowerCase());
  const named = NAMED_KEYS[lower];
  if (named) return { kind: 'press', keys: named };
  for (const [re, make] of VOICE_RULES) {
    const m = lower.match(re);
    if (m) {
      const cmd = make(m, original);
      if (cmd) return cmd;
    }
  }
  return null;
}

/** Commands that should never be routed through the LLM even if ambiguous. */
export function isInstant(cmd: Command): boolean {
  return cmd.kind !== 'ask' && cmd.kind !== 'code' && cmd.kind !== 'readScreen' && cmd.kind !== 'unread';
}
