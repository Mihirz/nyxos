"use strict";
var NyxCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // js/core-entry.ts
  var core_entry_exports = {};
  __export(core_entry_exports, {
    EXTRACT_JS: () => EXTRACT_JS,
    SHORTCODES: () => SHORTCODES,
    STOP_CLICKS_JS: () => STOP_CLICKS_JS,
    SUBMIT_JS: () => SUBMIT_JS,
    WATCH_JS: () => WATCH_JS,
    WATCH_TAKE_JS: () => WATCH_TAKE_JS,
    activateJs: () => activateJs,
    brailleLines: () => brailleLines,
    cellDots: () => cellDots,
    clickPointJs: () => clickPointJs,
    clickTextJs: () => clickTextJs,
    compact: () => compact,
    fillJs: () => fillJs,
    findJs: () => findJs,
    fuzzyScore: () => fuzzyScore,
    gameUrl: () => gameUrl,
    highlightJs: () => highlightJs,
    hoverJs: () => hoverJs,
    isInstant: () => isInstant,
    isKnownSite: () => isKnownSite,
    knownSite: () => knownSite,
    lookJs: () => lookJs,
    looksLikeUrl: () => looksLikeUrl,
    normalizeKeys: () => normalizeKeys,
    normalizeUrl: () => normalizeUrl,
    parseCommand: () => parseCommand,
    parseNumber: () => parseNumber,
    scrollByJs: () => scrollByJs,
    scrollJs: () => scrollJs,
    searchUrl: () => searchUrl,
    setSpokenOptions: () => setSpokenOptions,
    shortPageTitle: () => shortPageTitle,
    skim: () => skim,
    speakOptions: () => speakOptions,
    spokenKeys: () => spokenKeys,
    toBraille: () => toBraille
  });

  // ../src/core/commands.ts
  var SHORTCODES = [
    ["w", "list windows"],
    ["1-9", "choose option"],
    ["o <app|url>", "open"],
    ["g <n>", "go to line"],
    ["t <text>", "type text"],
    ["c <spoken code>", "type code (Claude formats it)"],
    ["k <keys>", "press keys, e.g. k cmd+s"],
    ["l [n]", "read current line (or n lines)"],
    ["r", "read screen"],
    ["?", "where am I"],
    ["n / p", "next / previous"],
    ["b", "back up one level"],
    ["s <query>", "search this site (or the web)"],
    ["h / a / f", "headings / links / form fields"],
    ["u", "unread messages"],
    ["m <name>: <text>", "message someone"],
    [".", "repeat last"],
    ["x", "stop talking"],
    ["+ / -", "speak faster / slower"],
    ["/ <anything>", "ask Claude"]
  ];
  var SMALL = {
    zero: 0,
    oh: 0,
    one: 1,
    won: 1,
    two: 2,
    to: 2,
    too: 2,
    three: 3,
    four: 4,
    for: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    ate: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19
  };
  var TENS = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fourty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  };
  function parseNumber(input) {
    const s = input.trim().toLowerCase().replace(/-/g, " ").replace(/,/g, "");
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const words2 = s.split(/\s+/).filter((w) => w && w !== "and");
    if (!words2.length) return null;
    if (words2.length > 1 && words2.every((w) => w in SMALL && SMALL[w] < 10)) {
      return parseInt(words2.map((w) => SMALL[w]).join(""), 10);
    }
    let total = 0, current = 0;
    for (const w of words2) {
      if (w in SMALL) current += SMALL[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w === "thousand") {
        total += (current || 1) * 1e3;
        current = 0;
      } else if (/^\d+$/.test(w)) current += parseInt(w, 10);
      else return null;
    }
    return total + current;
  }
  var KEY_ALIASES = {
    command: "cmd",
    cmd: "cmd",
    "\u2318": "cmd",
    super: "cmd",
    meta: "cmd",
    control: "ctrl",
    ctrl: "ctrl",
    ctl: "ctrl",
    option: "alt",
    opt: "alt",
    alt: "alt",
    shift: "shift",
    enter: "return",
    return: "return",
    escape: "escape",
    esc: "escape",
    tab: "tab",
    space: "space",
    backspace: "delete",
    delete: "delete",
    "forward delete": "forwarddelete",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    home: "home",
    end: "end",
    "page up": "pageup",
    "page down": "pagedown"
  };
  function normalizeKeys(input) {
    const s = input.toLowerCase().replace(/\b(key|keys|button)\b/g, "").trim();
    const parts = s.split(/[\s+\-]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const two = parts[i] + " " + (parts[i + 1] ?? "");
      if (KEY_ALIASES[two]) {
        out.push(KEY_ALIASES[two]);
        i++;
        continue;
      }
      out.push(KEY_ALIASES[parts[i]] ?? parts[i]);
    }
    return out.join("+");
  }
  var NAMED_KEYS = {
    save: "cmd+s",
    undo: "cmd+z",
    redo: "cmd+shift+z",
    copy: "cmd+c",
    paste: "cmd+v",
    cut: "cmd+x",
    "select all": "cmd+a",
    enter: "return",
    return: "return",
    submit: "return",
    "new line": "return",
    escape: "escape",
    cancel: "escape",
    tab: "tab",
    "close tab": "cmd+w",
    "close window": "cmd+w",
    "new tab": "cmd+t",
    "new file": "cmd+n",
    find: "cmd+f",
    backspace: "delete",
    "delete that": "delete",
    "command palette": "cmd+shift+p",
    quit: "cmd+q"
  };
  function clean(text) {
    return text.trim().replace(/^[\s"'“”]+|[\s"'“”.!?,]+$/g, "");
  }
  function stripFiller(s) {
    return s.replace(/^(hey|ok|okay|um|uh|so|now|and|then|no|yes|yeah|wait|alright)[,.]? +/g, "").replace(/^(hey|ok|okay|um|uh|so|now|and|then|no|yes|yeah|wait|alright)[,.]? +/g, "").replace(/^((hey )?(nyx|nix|nicks|nyx os|nyxos|callbacks),? )/g, "").replace(/^(can you |could you |would you |please |i want to |i'd like to |let's |lets )+/g, "").replace(/ please$/g, "").trim();
  }
  var SYMBOL_CODES = {
    "?": { kind: "whereAmI" },
    ".": { kind: "repeat" },
    "+": { kind: "rate", delta: 0.25 },
    "-": { kind: "rate", delta: -0.25 }
  };
  function parseCommand(raw, source = "voice") {
    if (source === "typed" && SYMBOL_CODES[raw.trim()]) return SYMBOL_CODES[raw.trim()];
    const text = clean(raw);
    if (!text) return null;
    if (source === "typed") {
      const typed = parseTyped(text);
      if (typed) return typed;
    }
    return parseVoice(text);
  }
  function parseTyped(text) {
    if (text.startsWith("/")) return { kind: "ask", text: text.slice(1).trim() };
    if (/^[1-9]\d?$/.test(text)) return { kind: "choose", index: parseInt(text, 10) };
    const m = text.match(/^(\S)(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    const [, code, rest = ""] = m;
    const arg = rest.trim();
    switch (code) {
      case "w":
        return arg ? null : { kind: "windows" };
      case "o":
        return arg ? { kind: "open", target: arg } : null;
      case "g": {
        const n = parseNumber(arg);
        return n != null ? { kind: "goToLine", line: n } : null;
      }
      case "t":
        return arg ? { kind: "type", text: rest } : null;
      case "c":
        return arg ? { kind: "code", spoken: arg } : null;
      case "k":
        return arg ? { kind: "press", keys: normalizeKeys(arg) } : null;
      case "l":
        return { kind: "readLine", count: arg ? parseNumber(arg) ?? 1 : 1 };
      case "r":
        return { kind: "readScreen", goal: arg || void 0 };
      case "?":
        return { kind: "whereAmI" };
      case "n":
        return arg ? null : { kind: "next" };
      case "p":
        return arg ? null : { kind: "previous" };
      case "b":
        return arg ? null : { kind: "back" };
      case "s":
        return arg ? { kind: "search", query: arg } : null;
      case "h":
        return { kind: "web", view: "headings" };
      case "a":
        return { kind: "web", view: "links" };
      case "f":
        return { kind: "web", view: "forms" };
      case "u":
        return { kind: "unread" };
      case "m": {
        const mm = arg.match(/^([^:]+):\s*([\s\S]+)$/);
        if (mm) return { kind: "reply", to: mm[1].trim(), text: mm[2] };
        return arg ? { kind: "reply", to: arg, text: "" } : null;
      }
      case ".":
        return { kind: "repeat" };
      case "x":
        return { kind: "stop" };
      case "+":
        return { kind: "rate", delta: 0.25 };
      case "-":
        return { kind: "rate", delta: -0.25 };
    }
    return null;
  }
  var QUALIFIED = /\b(under|below|over|above|less than|more than|cheaper|cheapest|priciest|most expensive|best|top|highest|lowest|rated|stars?|between|within|sort|filter|only|without|compare|vs|versus|deal|discount|on sale)\b|[$€£]|\bdollars?\b/;
  var VOICE_RULES = [
    [/^(stop|quiet|shut up|shh+|silence|be quiet)$/, () => ({ kind: "stop" })],
    [/^(repeat( that)?|say (that|it) again|what( did you say)?)$/, () => ({ kind: "repeat" })],
    [/^(help|what can i (say|do)|commands)$/, () => ({ kind: "help" })],
    [/^(where am i|what('s| is) (focused|selected)|status)$/, () => ({ kind: "whereAmI" })],
    [/^(speak |talk |read )?(faster|speed up)$/, () => ({ kind: "rate", delta: 0.25 })],
    [/^(speak |talk |read )?(slower|slow down)$/, () => ({ kind: "rate", delta: -0.25 })],
    [/^(screen curtain|curtain|screen) (on|off)$/, (m) => ({ kind: "curtain", on: m[1] === "screen" ? m[2] === "off" : m[2] === "on" })],
    [/^(turn (off|on) (the )?screen)$/, (m) => ({ kind: "curtain", on: m[2] === "off" })],
    [/^(performance|battery|low power|fast) mode( (on|off))?$/, (m) => ({ kind: "performance", on: m[3] !== "off" })],
    [/^(follow|echo) mode( (on|off))?$/, (m) => ({ kind: "follow", on: m[3] !== "off" })],
    // Ahmed et al. (UIST 2012): skim a page instead of hearing all of it.
    [/^(?:skim|skim (?:this|the) (?:page|article|post|story)|give me the gist|what's the gist|the gist|summari[sz]e (?:this|the) (?:page|article))$/, () => ({ kind: "web", view: "skim" })],
    // Zhang et al. (CHI 2021): find controls from pixels where the page has no labels.
    [/^(?:what can i (?:click|press|tap)|find (?:the )?(?:buttons|controls)(?: on (?:the )?screen)?|look for buttons|detect (?:the )?(?:buttons|controls))$/, () => ({ kind: "web", view: "detect" })],
    // Abdolrahmani et al. (ASSETS 2018): users want control over how much is said, and privacy.
    [/^(?:be brief|brief mode|talk less|shorter answers|less detail|be quiet(?:er)?|terse mode)$/, () => ({ kind: "verbosity", level: "brief" })],
    [/^(?:detailed mode|be detailed|talk more|longer answers|more detail(?:s)? (?:mode|from now on)|verbose mode)$/, () => ({ kind: "verbosity", level: "detailed" })],
    [/^(?:normal mode|normal detail|normal verbosity)$/, () => ({ kind: "verbosity", level: "normal" })],
    [/^(?:discreet|private|privacy) mode( (on|off))?$/, (m) => ({ kind: "discreet", on: m[2] !== "off" })],
    [/^(?:use|switch to|change to) (?:the )?(eleven ?labs|cartesia)(?: voice)?$/, (m) => ({ kind: "voice", provider: m[1].startsWith("eleven") ? "elevenlabs" : "cartesia" })],
    [/^(?:switch|change|swap|toggle) (?:the )?voice(?: provider)?$/, () => ({ kind: "voice", provider: "next" })],
    [/^(go back to |back to |show |list |switch )?(the )?(windows|window list|apps|app switcher)$/, () => ({ kind: "windows" })],
    [/^(switch windows|switch apps|what('s| is) open)$/, () => ({ kind: "windows" })],
    [/^(go |jump |move )?(back|up)( a level| one level)?$/, () => ({ kind: "back" })],
    [/^(?:read |show |open |go to |show me |see |view )?(?:the )?(?:top )?comments$/, () => ({ kind: "web", view: "comments" })],
    // "show me more comments", "read the rest of the comments": continue reading comments.
    [/^(?:show(?: me)?|read(?: me)?|give me|load|see|get|tell me|what are|more)? ?(?:the )?(?:more|other|rest of the|all the|next|remaining|some more) comments$/, () => ({ kind: "web", view: "comments", more: true })],
    // "What are the words?" on a game board, "what are my options" on a quiz: read the choices, no model call.
    [/^(?:what are|what're|read(?: out)?|list|tell me)(?: me)?(?: all)? (?:the |my )?(?:words|tiles|choices|options|cards|answers|squares)(?: for me)?(?: on (?:the|this) (?:page|board|screen))?$/, () => ({ kind: "web", view: "choices" })],
    [/^(next|next one|down|next comment|read next comment|next reply)$/, () => ({ kind: "next" })],
    // "go to the next post", "open the previous one": relative to what's being discussed, never a website.
    [/^(?:go to |open |show me |read |play |what's |what is |click(?: on)? )?(?:the )?(next|previous|prior|last) (post|one|item|result|article|story|video|product|thread|page|link|option|answer|song|episode|clue|word|comment)$/, (m) => ({ kind: "relative", dir: m[1] === "next" ? 1 : -1, noun: m[2] })],
    [/^(previous comment|last comment|previous reply)$/, () => ({ kind: "previous" })],
    [/^(previous|prev|last one|go previous)$/, () => ({ kind: "previous" })],
    [/^(?:choose |pick |select |option |number |open |go to )?(?:number |option )?(\w+(?: \w+)?)$/, (m) => {
      const n = parseNumber(m[1]);
      return n != null && n >= 1 && n <= 99 ? { kind: "choose", index: n } : null;
    }],
    [/^(?:go to|jump to|goto) line (.+)$/, (m) => {
      const n = parseNumber(m[1]);
      return n != null ? { kind: "goToLine", line: n } : null;
    }],
    [/^line (.+)$/, (m) => {
      const n = parseNumber(m[1]);
      return n != null ? { kind: "goToLine", line: n } : null;
    }],
    [/^(?:read|what's on|what is on) (?:the )?(?:current |this )?line$/, () => ({ kind: "readLine", count: 1 })],
    [/^read (?:the )?(?:next )?(.+) lines$/, (m) => ({ kind: "readLine", count: parseNumber(m[1]) ?? 5 })],
    [/^(?:read|describe|what's on|what is on) (?:the )?screen(?: for (.+))?$/, (m) => ({ kind: "readScreen", goal: m[1] })],
    [/^(?:look around|what do you see|what's here|what is here)$/, () => ({ kind: "readScreen" })],
    [/^(?:read|check) (?:my )?(?:unread|new) (?:messages|texts)$|^(?:any )?(?:unread|new) messages$|^unread$/, () => ({ kind: "unread" })],
    [/^(?:reply|respond)(?: to (.+?))?(?: saying|:| with)? (.+)$/, (m, o) => ({ kind: "reply", to: m[1], text: tail(o, m[2]) })],
    [/^(?:text|message|send a message to|tell) (.+?)(?: saying|:| that) ["“]?(.+)$/, (m, o) => ({ kind: "reply", to: m[1], text: tail(o, m[2]) })],
    [/^(?:text|message|send a message to|write to) (\w+(?: \w+)?)$/, (m, o) => ({ kind: "reply", to: tail(o, m[1]), text: "" })],
    [/^(?:show |list |read )?(?:the )?headings$/, () => ({ kind: "web", view: "headings" })],
    [/^(?:show |list |read )?(?:the )?links$/, () => ({ kind: "web", view: "links" })],
    [/^(?:show |list |read )?(?:the )?(?:form|forms|fields|inputs|text fields)$/, () => ({ kind: "web", view: "forms" })],
    [/^(?:show |list |read )?(?:the )?buttons$/, () => ({ kind: "web", view: "buttons" })],
    [/^(?:read (?:the )?(?:article|page|main content)|read it)$/, () => ({ kind: "web", view: "article" })],
    [/^(?:outline|overview|page outline|regions|landmarks)$/, () => ({ kind: "web", view: "outline" })],
    // "search X" searches the site you're on when it has a search box; "google X" always means the web.
    // A query with conditions (price, ranking, sorting) is flagged: on a site, Claude searches then filters.
    [/^(?:google|search the web for|search the web|web search|search online for|search google for) (.+)$/, (m, o) => ({ kind: "search", query: tail(o, m[1]), web: true })],
    [/^(?:search for|search|look up) (.+)$/, (m, o) => QUALIFIED.test(m[1]) ? { kind: "search", query: tail(o, m[1]), qualified: true } : { kind: "search", query: tail(o, m[1]) }],
    [/^scroll (up|down)$/, (m) => ({ kind: "scroll", direction: m[1] })],
    // "quick" and "clique" are how speech-to-text often hears "click".
    [/^(?:click|quick|clique|klick|press|tap|activate|hit) (?:on )?(?:the )?(.+) (\d+|\w+) times$/, (m) => {
      const n = parseNumber(m[2]);
      return n != null && n > 0 ? { kind: "click", target: m[1], times: Math.min(100, n) } : null;
    }],
    // "select those four and submit", "submit those four", "select the last four, then submit".
    [/^(?:select|choose|pick|click) (.+?),? (?:and |then |and then )submit(?: (?:it|them|those))?$/, (m) => ({ kind: "click", target: m[1], submit: true })],
    [/^submit (?:those|these|the) (?:\w+ )?(?:four|three|words|ones|tiles|last four|remaining four)$|^submit (?:the )?(?:last|remaining) (?:four|ones)$/, (m) => ({ kind: "click", target: m[0].replace(/^submit\s+/, ""), submit: true })],
    [/^(?:buy|select|choose) (?:a |an |the |one )?(.+)$/, (m) => ({ kind: "click", target: m[1] })],
    [/^(?:click|clique|klick|press|tap|activate) (?:on )?(?:the )?(.+?)(?: button| link)?$/, (m) => {
      const keyish = NAMED_KEYS[m[1]] ?? (/^(cmd|command|control|ctrl|option|alt|shift)\b/.test(m[1]) ? normalizeKeys(m[1]) : null);
      if (keyish) return { kind: "press", keys: keyish };
      return { kind: "click", target: m[1] };
    }],
    [/^(?:hit|press|key|shortcut) (.+)$/, (m) => ({ kind: "press", keys: NAMED_KEYS[m[1]] ?? normalizeKeys(m[1]) })],
    [/^(?:type|write|enter|dictate|insert) (?:code|the code) (.+)$/, (m, o) => ({ kind: "code", spoken: tail(o, m[1]) })],
    [/^code (.+)$/, (m, o) => ({ kind: "code", spoken: tail(o, m[1]) })],
    [/^(?:type|write|dictate|insert) (.+)$/, (m, o) => ({ kind: "type", text: tail(o, m[1]) })],
    [/^(?:play|let's play|start playing|start a game of|i want to play) (?:a |an |the |some )?(.+)$/, (m) => ({ kind: "open", target: m[1], play: true })],
    [/^(?:open|launch|start|switch to|go to|focus|show me|bring up|pull up) (.+)$/, (m) => ({ kind: "open", target: m[1] })]
  ];
  function tail(original, lowerCapture) {
    const idx = original.toLowerCase().lastIndexOf(lowerCapture);
    return idx >= 0 ? original.slice(idx, idx + lowerCapture.length) : lowerCapture;
  }
  function parseVoice(text) {
    const original = text;
    const lower = stripFiller(text.toLowerCase());
    const named = NAMED_KEYS[lower];
    if (named) return { kind: "press", keys: named };
    for (const [re, make] of VOICE_RULES) {
      const m = lower.match(re);
      if (m) {
        const cmd = make(m, original);
        if (cmd) return cmd;
      }
    }
    return null;
  }
  function isInstant(cmd) {
    return cmd.kind !== "ask" && cmd.kind !== "code" && cmd.kind !== "readScreen" && cmd.kind !== "unread";
  }

  // ../src/core/narration.ts
  var MAX_SPOKEN_OPTIONS = 5;
  var setSpokenOptions = (n) => {
    MAX_SPOKEN_OPTIONS = n;
  };
  var TRAILING_FILLER = /\s+(and|or|of|the|for|to|with|on|in|a|an|at|by|from|your|&)$/i;
  function compact(label, maxWords = 4) {
    let s = label.split(/\s[|•·–—-]\s|,\s|:\s|\.\s/)[0].trim() || label.trim();
    const words2 = s.split(/\s+/);
    if (words2.length > maxWords) {
      s = words2.slice(0, maxWords).join(" ");
      while (TRAILING_FILLER.test(s)) s = s.replace(TRAILING_FILLER, "");
    }
    return s;
  }
  function speakOptions(title, items, offset = 0) {
    if (!items.length) return `${title}: none.`;
    const labels = items.slice(offset, offset + MAX_SPOKEN_OPTIONS).map((it) => it.say ?? compact(it.label));
    const left = items.length - offset - labels.length;
    const body = left > 0 ? `${labels.join(", ")}, and ${left} more` : labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
    return offset === 0 && title ? `${title}: ${body}.` : `${body}.`;
  }
  function shortPageTitle(title) {
    const first = title.split(/\s[|•·–—-]\s|[.:!]\s/)[0].trim() || title;
    return compact(first.replace(/\.(com|org|net|io|ai|dev|co)$/i, ""), 5);
  }

  // ../src/core/skim.ts
  var STOP = new Set(`a an the and or but if then than so of to in on at by for with from as is are was were be been being it its this that these those he she they we you i his her their our your my me him them us not no do does did done have has had having will would can could should may might must shall about into over after before more most other some such only own same too very just also there here when where which who whom what why how all any both each few nor off out up down again further once one two three said says say per via`.split(/\s+/));
  var words = (s) => s.toLowerCase().match(/[a-z][a-z'’-]+/g) ?? [];
  function skim(text, ratio = 0.15, min = 3, max = 8) {
    const paragraphs = text.split(/\n\s*\n|\n(?=[A-Z])/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 40);
    const all = [];
    paragraphs.forEach((p, para) => {
      const ss = p.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [p];
      ss.map((s) => s.trim()).filter((s) => s.split(" ").length >= 5).forEach((s, i) => all.push({ s, para, first: i === 0 }));
    });
    if (!all.length) return { sentences: [], total: 0 };
    const freq = /* @__PURE__ */ new Map();
    for (const { s } of all) for (const w of words(s)) if (!STOP.has(w) && w.length > 2) freq.set(w, (freq.get(w) ?? 0) + 1);
    const top = Math.max(1, ...freq.values());
    const scored = all.map((x, i) => {
      const ws = words(x.s).filter((w) => !STOP.has(w) && w.length > 2);
      const density = ws.reduce((n, w) => n + (freq.get(w) ?? 0) / top, 0) / Math.max(4, Math.sqrt(ws.length) * 2);
      const position = (x.first ? 0.35 : 0) + (x.para === 0 ? 0.25 : 0) + (i === 0 ? 0.4 : 0);
      const length = x.s.length > 280 ? -0.25 : x.s.length < 50 ? -0.15 : 0;
      return { i, s: x.s, score: density + position + length };
    });
    const keep = Math.max(min, Math.min(max, Math.round(all.length * ratio)));
    const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, keep).sort((a, b) => a.i - b.i);
    return { sentences: chosen.map((c) => c.s), total: all.length };
  }

  // ../src/core/braille.ts
  var dots = (...ds) => String.fromCharCode(10240 + ds.reduce((acc, d) => acc | 1 << d - 1, 0));
  var LETTERS = {
    a: dots(1),
    b: dots(1, 2),
    c: dots(1, 4),
    d: dots(1, 4, 5),
    e: dots(1, 5),
    f: dots(1, 2, 4),
    g: dots(1, 2, 4, 5),
    h: dots(1, 2, 5),
    i: dots(2, 4),
    j: dots(2, 4, 5),
    k: dots(1, 3),
    l: dots(1, 2, 3),
    m: dots(1, 3, 4),
    n: dots(1, 3, 4, 5),
    o: dots(1, 3, 5),
    p: dots(1, 2, 3, 4),
    q: dots(1, 2, 3, 4, 5),
    r: dots(1, 2, 3, 5),
    s: dots(2, 3, 4),
    t: dots(2, 3, 4, 5),
    u: dots(1, 3, 6),
    v: dots(1, 2, 3, 6),
    w: dots(2, 4, 5, 6),
    x: dots(1, 3, 4, 6),
    y: dots(1, 3, 4, 5, 6),
    z: dots(1, 3, 5, 6)
  };
  var DIGITS = "jabcdefghi";
  var NUMBER_SIGN = dots(3, 4, 5, 6);
  var CAPITAL_SIGN = dots(6);
  var CAPITAL_WORD = dots(6) + dots(6);
  var PUNCT = {
    ",": dots(2),
    ";": dots(2, 3),
    ":": dots(2, 5),
    ".": dots(2, 5, 6),
    "!": dots(2, 3, 5),
    "?": dots(2, 3, 6),
    "'": dots(3),
    "-": dots(3, 6),
    '"': dots(2, 3, 6),
    "\u201C": dots(2, 3, 6),
    "\u201D": dots(3, 5, 6),
    "(": dots(5) + dots(1, 2, 6),
    ")": dots(5) + dots(3, 4, 5),
    "/": dots(4, 5, 6) + dots(3, 4),
    "@": dots(4) + dots(1),
    "#": dots(4, 5, 6) + dots(1, 4, 5, 6),
    "&": dots(4) + dots(1, 2, 3, 4, 6),
    "*": dots(5) + dots(3, 5),
    "+": dots(5) + dots(2, 3, 5),
    "=": dots(5) + dots(2, 3, 5, 6),
    "<": dots(4) + dots(1, 2, 6),
    ">": dots(4) + dots(3, 4, 5),
    "_": dots(4, 6) + dots(3, 6),
    "[": dots(4, 6) + dots(1, 2, 6),
    "]": dots(4, 6) + dots(3, 4, 5),
    "{": dots(4, 5, 6) + dots(1, 2, 6),
    "}": dots(4, 5, 6) + dots(3, 4, 5),
    "$": dots(4) + dots(2, 3, 4),
    "%": dots(4, 6) + dots(3, 5, 6),
    "\n": dots(),
    " ": dots()
  };
  var WORDSIGNS = {
    and: dots(1, 2, 3, 4, 6),
    for: dots(1, 2, 3, 4, 5, 6),
    of: dots(1, 2, 3, 5, 6),
    the: dots(2, 3, 4, 6),
    with: dots(2, 3, 4, 5, 6),
    but: LETTERS.b,
    can: LETTERS.c,
    do: LETTERS.d,
    every: LETTERS.e,
    from: LETTERS.f,
    go: LETTERS.g,
    have: LETTERS.h,
    just: LETTERS.j,
    knowledge: LETTERS.k,
    like: LETTERS.l,
    more: LETTERS.m,
    not: LETTERS.n,
    people: LETTERS.p,
    quite: LETTERS.q,
    rather: LETTERS.r,
    so: LETTERS.s,
    that: LETTERS.t,
    us: LETTERS.u,
    very: LETTERS.v,
    will: LETTERS.w,
    it: LETTERS.x,
    you: LETTERS.y,
    as: LETTERS.z
  };
  var GROUPSIGNS = [
    ["ing", dots(3, 4, 6)],
    ["and", dots(1, 2, 3, 4, 6)],
    ["the", dots(2, 3, 4, 6)],
    ["for", dots(1, 2, 3, 4, 5, 6)],
    ["ch", dots(1, 6)],
    ["sh", dots(1, 4, 6)],
    ["th", dots(1, 4, 5, 6)],
    ["wh", dots(1, 5, 6)],
    ["ou", dots(1, 2, 5, 6)],
    ["st", dots(3, 4)],
    ["ed", dots(1, 2, 4, 6)],
    ["er", dots(1, 2, 4, 5, 6)],
    ["ar", dots(3, 4, 5)],
    ["ow", dots(2, 4, 6)],
    ["gh", dots(1, 2, 6)]
  ];
  function letters(word, grade) {
    let out = "";
    let i = 0;
    const lower = word.toLowerCase();
    while (i < lower.length) {
      if (grade === 2) {
        const g = GROUPSIGNS.find(([seq]) => lower.startsWith(seq, i));
        if (g) {
          out += g[1];
          i += g[0].length;
          continue;
        }
      }
      out += LETTERS[lower[i]] ?? "";
      i++;
    }
    return out;
  }
  function encodeWord(word, grade) {
    const lower = word.toLowerCase();
    const isAllCaps = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
    const prefix = isAllCaps ? CAPITAL_WORD : /^[A-Z]/.test(word) ? CAPITAL_SIGN : "";
    if (grade === 2 && WORDSIGNS[lower]) return prefix + WORDSIGNS[lower];
    if (!isAllCaps && /[A-Z]/.test(word.slice(1))) {
      return [...word].map((ch) => (/[A-Z]/.test(ch) ? CAPITAL_SIGN : "") + letters(ch, 1)).join("");
    }
    return prefix + letters(word, grade);
  }
  function toBraille(text, grade = 2) {
    let out = "";
    const tokens = text.match(/[A-Za-z]+|\d+(?:[.,]\d+)*|\s+|./gsu) ?? [];
    for (const tok of tokens) {
      if (/^[A-Za-z]+$/.test(tok)) out += encodeWord(tok, grade);
      else if (/^\d/.test(tok)) {
        out += NUMBER_SIGN + [...tok].map((ch) => /\d/.test(ch) ? LETTERS[DIGITS[+ch]] : PUNCT[ch] ?? "").join("");
      } else if (/^\s+$/.test(tok)) out += tok.includes("\n") ? "\n" : dots();
      else out += PUNCT[tok] ?? "";
    }
    return out;
  }
  function cellDots(cell) {
    const bits = cell.charCodeAt(0) - 10240;
    return Array.from({ length: 8 }, (_, i) => (bits & 1 << i) !== 0);
  }
  function brailleLines(text, cells = 40, grade = 2) {
    const lines = [];
    let cur = "";
    const push = () => {
      if (cur) lines.push({ print: cur, braille: toBraille(cur, grade) });
      cur = "";
    };
    for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
      const next = cur ? `${cur} ${word}` : word;
      if (toBraille(next, grade).length <= cells) {
        cur = next;
        continue;
      }
      push();
      let w = word;
      while (toBraille(w, grade).length > cells) {
        let n = w.length;
        while (n > 1 && toBraille(w.slice(0, n), grade).length > cells) n--;
        lines.push({ print: w.slice(0, n), braille: toBraille(w.slice(0, n), grade) });
        w = w.slice(n);
      }
      cur = w;
    }
    push();
    return lines.length ? lines : [{ print: "", braille: "" }];
  }

  // ../src/renderer/lens/extract.ts
  var EXTRACT_JS = String.raw`(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && (r.width > 0 || r.height > 0);
  };
  window.__cbN = window.__cbN || 0;
  const tag = (el) => el.dataset.cb || (el.dataset.cb = 'e' + (++window.__cbN));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const l = document.getElementById(by); if (l) return clean(l.innerText); }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.innerText); }
    const wrap = el.closest('label'); if (wrap) return clean(wrap.innerText);
    return clean(el.placeholder || el.title || el.name || el.value || el.innerText || el.alt || '');
  };

  // Prices: "$ 29 . 99" across spans, "$1,299", "29,99 €".
  const PRICE = /(?:[$£€]\s?\d[\d,]*(?:\s?\.\s?\d{2})?)|(?:\d[\d.,]*\s?€)/;
  const priceIn = (el) => {
    const off = el.querySelector('.a-price .a-offscreen, [itemprop=price], [data-testid*=price], [class*=price]');
    const t = off ? (off.getAttribute('content') && !/[$£€]/.test(off.innerText) ? '$' + off.getAttribute('content') : off.textContent) : '';
    const m = (t && t.match(PRICE)) || (el.innerText || '').match(PRICE);
    return m ? m[0].replace(/\s+/g, '') : undefined;
  };
  // The product card around a link: the nearest list item / article / tile, kept small.
  const cardOf = (el) => {
    const known = el.closest('[data-component-type=s-search-result],[data-asin]:not([data-asin=""])');
    if (known) return known;
    const c = el.closest('article,li,[role=listitem],[class*=card],[class*=product]');
    return c && c !== document.body && (c.textContent || '').length < 4000 ? c : null;
  };

  // "bigCookie" → "big cookie": names for controls that have no text (icon buttons, game pieces).
  const human = (s) => s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim().toLowerCase();

  const items = [];
  const seenHref = new Set();
  const byEl = new Map();
  // One entry per element, even when it matches two selectors (e.g. a combobox button).
  // Ads are never read: anything inside an ad container is skipped everywhere.
  const AD = 'shreddit-ad-post, [data-testid*="ad-" i], [id^=google_ads], ins.adsbygoogle, [aria-label*="advertisement" i], [class*="sponsored" i], [data-promoted=true], [data-component-type=sp-sponsored-result]';
  const isAd = (el) => !!el.closest(AD);
  const elById = new Map();
  // Ad contents are skipped, except the controls that get you past an ad ("Continue to
  // Connections", "Skip advertisement", "Close"): without them a game's ad gate is a dead end.
  const passAd = (item) => (item.kind === 'button' || item.kind === 'link') && /^(continue|skip|close|play|no thanks|dismiss)\b/i.test(item.label || '');
  const add = (el, item) => { if (byEl.has(el) || (isAd(el) && !passAd(item))) return; item.id = tag(el); items.push(item); byEl.set(el, item); elById.set(item.id, el); };

  document.querySelectorAll('h1,h2,h3,h4,[role=heading]').forEach((h) => {
    if (!visible(h)) return;
    const label = clean(h.innerText).slice(0, 140);
    if (label) add(h, { kind: 'heading', level: Number(h.getAttribute('aria-level') || h.tagName[1]) || 2, label });
  });
  document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),textarea,select,[contenteditable=true],[role=searchbox],[role=textbox],[role=combobox]').forEach((el) => {
    if (!visible(el)) return;
    add(el, { kind: 'input', label: (labelFor(el) || el.type || 'text field').slice(0, 80), inputType: el.type || el.tagName.toLowerCase() });
  });
  // role=option covers crossword clue lists (selecting a clue selects its entry and direction).
  document.querySelectorAll('button,[role=button],[role=option],input[type=submit],input[type=button]').forEach((el) => {
    if (!visible(el)) return;
    const label = labelFor(el).slice(0, 80) || (el.id ? human(el.id) : '');
    if (label) add(el, { kind: 'button', label });
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    if (!visible(a) || seenHref.has(a.href) || a.href.startsWith('javascript:')) return;
    const label = labelFor(a).slice(0, 120);
    if (!label) return;
    seenHref.add(a.href);
    const card = cardOf(a);
    const price = card ? priceIn(card) : undefined;
    add(a, card ? { kind: 'link', label, href: a.href, price, card: tag(card) } : { kind: 'link', label, href: a.href });
  });

  // Clickable things that aren't links or buttons: game pieces, tiles, custom widgets.
  // A pointer cursor is the tell; cursor is inherited, so keep only the outermost one.
  const clickRoots = [];
  document.querySelectorAll('[onclick],[tabindex]:not([tabindex="-1"]),div[id],span[id],canvas[id],[class*=btn],[class*=button],[class*=clickable],[class*=product],[class*=option],[class*=tile]').forEach((el) => {
    if (clickRoots.length >= 80 || byEl.has(el) || el.closest('a,button,input,select,textarea') || !visible(el)) return;
    if (clickRoots.some((r) => r.contains(el)) || getComputedStyle(el).cursor !== 'pointer') return;
    const text = clean(el.getAttribute('aria-label') || el.title || el.innerText || '');
    if (text.length > 160) return; // a big container, not a control
    const firstLine = clean((el.getAttribute('aria-label') || el.title || el.innerText || '').split('\n').find((l) => l.trim()) || '');
    const label = firstLine.slice(0, 80) || (el.id ? human(el.id) : '');
    if (!label) return;
    clickRoots.push(el);
    add(el, { kind: 'button', label });
  });

  // Regions: landmarks, each listing the items inside it.
  const regionSel = 'header,nav,main,aside,footer,form,section[aria-label],section[aria-labelledby],[role=banner],[role=navigation],[role=main],[role=search],[role=complementary],[role=contentinfo],[role=dialog],dialog[open]';
  const nameOf = (r) => {
    const role = r.getAttribute('role') || ({ HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'sidebar', FOOTER: 'footer', FORM: 'form', SECTION: 'section', DIALOG: 'dialog' })[r.tagName] || 'region';
    const label = r.getAttribute('aria-label') || (r.querySelector('h1,h2,h3') ? clean(r.querySelector('h1,h2,h3').innerText).slice(0, 50) : '');
    return label ? role + ': ' + label : role;
  };
  const regions = [...document.querySelectorAll(regionSel)].filter(visible).filter((r) => !r.parentElement || !r.parentElement.closest('form') || r.tagName !== 'FORM');
  // Visual salience, after SaIL (Aydin et al., IUI 2020), which ranks regions by where sighted
  // users look: here approximated from layout. Big, near the top of the first screen, large
  // type, pictures: more salient. Navigation and footers: less.
  const vw = innerWidth, vh = innerHeight;
  const salience = (el) => {
    const r = el.getBoundingClientRect();
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh * 1.5) - Math.max(r.top, 0));
    const area = (visW * visH) / (vw * vh * 1.5);
    const top = r.top < vh ? 1 - Math.max(0, r.top) / vh : 0;
    const center = 1 - Math.min(1, Math.abs((r.left + r.right) / 2 - vw / 2) / (vw / 2));
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const media = el.querySelector && el.querySelector('img,video,canvas') ? 0.15 : 0;
    const chrome = el.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]') ? -0.35 : 0;
    return Math.max(0, Math.min(1, area * 0.9 + top * 0.35 + center * 0.15 + Math.min(1, (fs - 12) / 24) * 0.25 + media + chrome));
  };
  // Salience for the first 400 items is plenty (the rest are far down busy pages) and keeps this fast.
  for (const it of items.slice(0, 400)) { const el = elById.get(it.id); if (el) it.sal = Math.round(salience(el) * 100) / 100; }

  const regionItems = regions.map((r) => {
    const kids = items.filter((it) => r.contains(elById.get(it.id)));
    const count = { links: 0, inputs: 0, buttons: 0, headings: 0 };
    kids.forEach((k) => { count[{ link: 'links', input: 'inputs', button: 'buttons', heading: 'headings' }[k.kind]]++; });
    return { id: tag(r), kind: 'region', label: nameOf(r), children: kids.map((k) => k.id), count, sal: Math.round(salience(r) * 100) / 100 };
  }).filter((r) => r.children.length);
  // Drop a region when a region nested inside it covers exactly the same items
  // (e.g. <header> that only wraps a <nav>): one stop, not two.
  const same = (a, b) => a.children.length === b.children.length && a.children.every((id, i) => id === b.children[i]);
  const elOf = (r) => document.querySelector('[data-cb="' + r.id + '"]');
  const dedupedRegions = regionItems.filter((r) => !regionItems.some((o) => o !== r && same(o, r) && elOf(r).contains(elOf(o))));

  // documentElement as a last resort: a page caught mid-load can have no body yet.
  const main = document.querySelector('main,[role=main],article') || document.body || document.documentElement;
  // Readable units, in order: the post, then comments (with author and depth), for "read the comments".
  const blocks = [];
  const post = document.querySelector('shreddit-post, [data-testid=post-container], article[data-type=post]');
  if (post && !isAd(post)) blocks.push({ kind: 'post', author: post.getAttribute('author') || '', text: clean(post.innerText).slice(0, 1200) });
  document.querySelectorAll('shreddit-comment, [data-testid=comment], .comment, [role=comment], li[id^=comment], article[data-type=comment]').forEach((c) => {
    if (blocks.length > 80 || isAd(c)) return;
    const own = c.querySelector(':scope > [slot=comment], :scope > .md, :scope > .comment-body, :scope > div [id$=-comment-rtjson-content]') || c.querySelector('[slot=comment], .md, .comment-body, p');
    const text = clean(own ? own.innerText : c.innerText).slice(0, 700);
    if (!text) return;
    blocks.push({ kind: 'comment', author: c.getAttribute('author') || clean((c.querySelector('[slot=authorName], .author, a[href*="/user/"]') || {}).innerText || ''), score: c.getAttribute('score') || '', depth: Number(c.getAttribute('depth') || 0), text });
  });
  // A feed's posts in order (Reddit, news lists), so "next post" can go straight to the next one.
  const posts = [];
  const seenPost = new Set();
  document.querySelectorAll('shreddit-post, article, [data-testid=post-container]').forEach((p) => {
    if (posts.length >= 60 || isAd(p)) return;
    const title = p.getAttribute('post-title') || clean((p.querySelector('h1,h2,h3,[slot=title]') || {}).innerText || '');
    let href = p.getAttribute('permalink') || '';
    if (!href) { const a = p.querySelector('a[slot=full-post-link], h1 a[href], h2 a[href], h3 a[href], a[href][data-click-id=body]'); href = a ? a.getAttribute('href') : ''; }
    if (!title || !href) return;
    try { href = new URL(href, location.href).href; } catch { return; }
    if (seenPost.has(href)) return;
    seenPost.add(href);
    posts.push({ title: title.slice(0, 160), href });
  });
  const adText = [...document.querySelectorAll(AD)].map((a) => a.innerText || '').filter((t) => t.length > 20);
  let article = (main.innerText || '').slice(0, 40000);
  // Prose for skimming: real paragraphs only (no infobox coordinates, menus, or captions).
  const prose = [...main.querySelectorAll('p')].filter((p) => !p.closest('table,nav,aside,figure,header,footer,.infobox') && visible(p))
    .map((p) => clean(p.innerText)).filter((t) => t.length > 60 && (t.match(/[a-z]/g) || []).length > t.length * 0.5).join('\n\n').slice(0, 40000);
  for (const t of adText) article = article.split(t).join(' ');
  // Product pages: the buy-box price, else the first price near the top of the page.
  const buy = document.querySelector('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #apex_desktop, [itemprop=offers], [data-testid=price], .product-price, .price');
  const pagePrice = (buy && visible(buy) && priceIn(buy)) || undefined;
  const canvasShare = Math.max(0, ...[...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh); }));
  return {
    url: location.href,
    title: clean(document.title) || location.hostname,
    canvas: Math.round(canvasShare * 100) / 100,
    // Busy pages (Amazon) have hundreds of filter buttons before the product links: keep plenty.
    items: [...dedupedRegions, ...items].slice(0, 1500),
    article,
    prose,
    blocks,
    posts,
    price: pagePrice,
  };
})()`;
  var activateJs = (id, times = 1) => String.raw`(async () => {
  const el = document.querySelector('[data-cb="${id}"]');
  if (!el) return false;
  document.querySelectorAll('[data-cb-focus]').forEach((x) => { x.removeAttribute('data-cb-focus'); x.style.outline = x.dataset.cbOutline || ''; });
  el.dataset.cbOutline = el.style.outline;
  el.setAttribute('data-cb-focus', '1');
  el.style.outline = '6px solid #FFD400';
  el.style.outlineOffset = '3px';
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  // Checkboxes and radio buttons (Connections' word tiles) are toggled; text fields get focus.
  if (el.matches('input[type=checkbox],input[type=radio]')) { el.click(); return { checked: el.checked }; }
  if (el.matches('input,textarea,select,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]')) el.focus();
  else if (el.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) {
    // A heading that is (or wraps) a link, like a product title: follow the link.
    const link = el.closest('a[href]') || el.querySelector('a[href]');
    if (link) link.click();
    else { el.setAttribute('tabindex', '-1'); el.focus(); }
  }
  else {
    window.__cbStop = false;
    for (let i = 0; i < ${Math.max(1, Math.min(100, times))} && !window.__cbStop; i++) {
      if (i) await new Promise((r) => setTimeout(r, 350));
      el.click();
    }
  }
  return true;
})()`;
  var fillJs = (id, text) => String.raw`(() => {
  const el = document.querySelector('[data-cb="${id}"]');
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
  else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
  var SUBMIT_JS = String.raw`(() => {
  const el = document.activeElement;
  const form = el && el.form;
  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'submitted'; }
  return 'none';
})()`;
  var scrollJs = (dir) => `window.scrollBy({ top: ${dir === "down" ? "" : "-"}window.innerHeight * 0.8, behavior: 'instant' })`;
  var findJs = (query) => String.raw`(() => {
  const words = ${JSON.stringify(query.toLowerCase())}.split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const blocks = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.toLowerCase();
    if (t.length < 3 || !words.some((w) => t.includes(w))) continue;
    let el = n.parentElement;
    if (!el || el.closest('script,style,noscript')) continue;
    // Grow to the post/card around the hit, but stop before a whole column.
    while (el.parentElement && el.parentElement !== document.body && (el.parentElement.textContent || '').length < 700) el = el.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const hits = words.filter((w) => text.toLowerCase().includes(w)).length;
    if (text && !blocks.has(el)) blocks.set(el, { text: text.slice(0, 600), hits });
    if (blocks.size > 200) break;
  }
  return [...blocks.values()].sort((a, b) => b.hits - a.hits).slice(0, 6).map((b) => b.text);
})()`;
  var CLICKER = String.raw`async (el, times, until, how) => {
  if (!el) return { clicked: false };
  // A point click that lands on a full-page layer (a dialog's dimmed backdrop) would do nothing useful.
  const box = el.getBoundingClientRect();
  if (how === 'point' && box.width * box.height > innerWidth * innerHeight * 0.6) {
    const dialog = document.querySelector('dialog[open], [role=dialog], [aria-modal=true], .prompt, #prompt, [class*=modal]:not([style*="none"])');
    return { clicked: false, blocked: true, label: dialog ? (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '' };
  }
  document.querySelectorAll('[data-cb-focus]').forEach((x) => { x.removeAttribute('data-cb-focus'); x.style.outline = x.dataset.cbOutline || ''; });
  el.dataset.cbOutline = el.style.outline;
  el.setAttribute('data-cb-focus', '1');
  el.style.outline = '6px solid #FFD400';
  const count = (t) => t ? ((document.body.innerText || '').toLowerCase().split(t.toLowerCase()).length - 1) : 0;
  const before = count(until);
  const textBefore = (el.innerText || '').replace(/\s+/g, ' ').trim();
  window.__cbStop = false;
  let n = 0, reached = false;
  const max = until ? Math.max(times, 100) : times;
  for (; n < max && !window.__cbStop; n++) {
    if (n) await new Promise((r) => setTimeout(r, 350));
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    if (until && count(until) > before) { reached = true; n++; break; }
  }
  const label = (el.getAttribute('aria-label') || el.innerText || el.id || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
  // What appeared: the words right after the newest "until" text ("Achievement unlocked Stifling the press").
  let found = '';
  if (reached) {
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    const at = body.toLowerCase().lastIndexOf(until.toLowerCase());
    found = body.slice(at, at + until.length + 50).replace(/ [×✕x] ?$/, '').trim();
  }
  const textAfter = (el.innerText || '').replace(/\s+/g, ' ').trim();
  return { clicked: true, times: n, label, how, reached, found, stopped: window.__cbStop, textBefore, textAfter };
}`;
  var clickTextJs = (text, times = 1, until = "") => String.raw`(async () => {
  const want = ${JSON.stringify(text.toLowerCase())};
  // The smallest visible element whose text contains the words.
  let best = null, bestLen = Infinity;
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 8) continue;
    const t = (el.textContent || '').toLowerCase();
    if (!t.includes(want) || t.length >= bestLen) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    best = el; bestLen = t.length;
  }
  return (${CLICKER})(best, ${Math.max(1, Math.min(100, times))}, ${JSON.stringify(until)}, 'text');
})()`;
  var clickPointJs = (x, y, times = 1, until = "") => String.raw`(async () => {
  // The smallest visible element under the point: a ticker inside a toolbar, not the toolbar.
  // (The click still bubbles up, so handlers on the containers fire too.)
  const stack = document.elementsFromPoint(${Math.round(x)}, ${Math.round(y)})
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width * r.height > 100);
  stack.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  const el = stack.length ? stack[0].e : document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  return (${CLICKER})(el, ${Math.max(1, Math.min(100, times))}, ${JSON.stringify(until)}, 'point');
})()`;
  var STOP_CLICKS_JS = "window.__cbStop = true";
  var WATCH_JS = String.raw`(() => {
  if (window.__cbWatch) return true;
  // Appended elements are remembered, and judged when we're about to speak: only what a
  // sighted person can actually see counts. Games build hidden shop rows and tooltips ahead of
  // time (Cookie Clicker's locked buildings); announcing those would be making things up.
  window.__cbAdded = [];
  window.__cbWatch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type !== 'childList' || r.removedNodes.length) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.closest('script,style,iframe,[aria-hidden=true]')) continue;
        window.__cbAdded.push(n);
        if (window.__cbAdded.length > 40) window.__cbAdded.shift();
      }
    }
  });
  window.__cbWatch.observe(document.body, { childList: true, subtree: true });
  return true;
})()`;
  var WATCH_TAKE_JS = String.raw`(() => {
  const nodes = window.__cbAdded || [];
  window.__cbAdded = [];
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1) return false;
    }
    return true;
  };
  const out = [];
  for (const n of nodes) {
    if (!shown(n)) continue;
    // Join text pieces with spaces ("<b>Priya</b>Is it fixed" → "Priya: Is it fixed"):
    // a short bold/name-like first piece reads as the sender.
    const parts = [];
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    for (let x = w.nextNode(); x; x = w.nextNode()) {
      const v = x.nodeValue.trim();
      // Skip hidden copies (Connections repeats every word in an aria-hidden span), invisible pieces, and repeats.
      if (!v || (x.parentElement && (x.parentElement.closest('[aria-hidden=true],.visually-hidden,.sr-only') || !shown(x.parentElement)))) continue;
      if (!parts.some((p) => p.v === v)) parts.push({ v, el: x.parentElement });
    }
    if (!parts.length) continue;
    const first = parts[0];
    const sender = parts.length > 1 && first.v.length < 32 && first.el && first.el !== n && /^(B|STRONG|H\d|SPAN|A)$/.test(first.el.tagName);
    const t = (sender ? first.v + ': ' + parts.slice(1).map((p) => p.v).join(' ') : parts.map((p) => p.v).join(' ')).replace(/\s+/g, ' ').trim();
    if (t.length < 20 || /sponsored|advertisement|promoted/i.test(t) || out.includes(t)) continue;
    out.push(t.slice(0, 400));
  }
  return out;
})()`;
  var lookJs = (text) => String.raw`(() => {
  const want = ${JSON.stringify(text.toLowerCase())};
  let hit = null, len = Infinity;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.parentElement && n.parentElement.textContent || '').toLowerCase();
    if (n.nodeValue.toLowerCase().includes(want.slice(0, 40)) && t.length < len) { hit = n.parentElement; len = t.length; }
  }
  if (!hit) return null;
  // The post/card around the text, and the largest image or video inside it.
  let card = hit;
  while (card.parentElement && card.parentElement !== document.body && !card.querySelector('img,video,canvas,picture') && card.textContent.length < 3000) card = card.parentElement;
  const media = [...card.querySelectorAll('img,video,canvas,picture')]
    .map((m) => ({ m, r: m.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 80 && r.height > 80)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  const target = media ? media.m : card;
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = target.getBoundingClientRect();
  const alt = media && (media.m.getAttribute('alt') || media.m.getAttribute('aria-label') || '');
  return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight), media: !!media, alt, text: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
})()`;
  var hoverJs = (text, x, y) => String.raw`(async () => {
  let el = null;
  const want = ${JSON.stringify((text ?? "").toLowerCase())};
  if (want) {
    let len = Infinity;
    for (const e of document.querySelectorAll('body *')) {
      const t = (e.textContent || '').toLowerCase();
      if (e.children.length < 8 && t.includes(want) && t.length < len) { el = e; len = t.length; }
    }
  } else el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  if (!el) return null;
  const before = document.body.innerText || '';
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(type, opts));
  await new Promise((res) => setTimeout(res, 300));
  const after = document.body.innerText || '';
  const added = after.split('\n').filter((l) => l.trim() && !before.includes(l)).join(' ').replace(/\s+/g, ' ').trim();
  return { label: (el.getAttribute('title') || el.getAttribute('aria-label') || '').slice(0, 200), tooltip: added.slice(0, 500) };
})()`;
  var scrollByJs = (dir, screens) => `(() => { window.scrollBy({ top: ${dir === "down" ? "" : "-"}window.innerHeight * 0.85 * ${Math.max(1, Math.min(10, screens))}, behavior: 'instant' }); return { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) }; })()`;
  var highlightJs = (ids) => String.raw`(() => {
  document.querySelectorAll('[data-cb-hl]').forEach((x) => { x.removeAttribute('data-cb-hl'); x.style.outline = x.dataset.cbHlOutline || ''; });
  const els = ${JSON.stringify(ids)}.map((id) => document.querySelector('[data-cb="' + id + '"]')).filter(Boolean);
  els.forEach((el) => {
    if (el.hasAttribute('data-cb-focus')) return;
    el.dataset.cbHlOutline = el.style.outline;
    el.setAttribute('data-cb-hl', '1');
    el.style.outline = '3px dashed #FFD400';
    el.style.outlineOffset = '2px';
  });
  if (els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  return els.length;
})()`;

  // ../src/main/web.ts
  function normalizeUrl(input) {
    const s = input.trim().replace(/\s+dot\s+/gi, ".").replace(/^(localhost|[\w-]+(?:\.[\w-]+)+)(?:\s+colon)?\s+(\d{2,5})\b/i, "$1:$2").replace(/\s+slash\s+/gi, "/").replace(/\s+/g, "");
    if (/^https?:\/\//i.test(s)) return s;
    if (/^localhost(:\d+)?/i.test(s)) return `http://${s}`;
    if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`;
    return searchUrl(input);
  }
  var searchUrl = (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  var KNOWN_SITES = {
    amazon: "amazon.com",
    youtube: "youtube.com",
    google: "google.com",
    gmail: "mail.google.com",
    github: "github.com",
    wikipedia: "en.wikipedia.org",
    reddit: "reddit.com",
    twitter: "x.com",
    x: "x.com",
    facebook: "facebook.com",
    instagram: "instagram.com",
    linkedin: "linkedin.com",
    netflix: "netflix.com",
    ebay: "ebay.com",
    target: "target.com",
    walmart: "walmart.com",
    yelp: "yelp.com",
    "hacker news": "news.ycombinator.com",
    "stack overflow": "stackoverflow.com",
    "google maps": "maps.google.com",
    "google docs": "docs.google.com",
    "google drive": "drive.google.com",
    "cookie clicker": "orteil.dashnet.org/cookieclicker/",
    connections: "nytimes.com/games/connections",
    "nyt connections": "nytimes.com/games/connections",
    wordle: "nytimes.com/games/wordle/index.html",
    "spend bill gates money": "neal.fun/spend/",
    "new york times": "nytimes.com",
    nytimes: "nytimes.com",
    cnn: "cnn.com",
    bbc: "bbc.com",
    espn: "espn.com",
    claude: "claude.ai"
  };
  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
  }
  function knownSite(name) {
    const key = name.toLowerCase().replace(/^the /, "").replace(/ (website|site|dot com)$/, "").trim();
    if (KNOWN_SITES[key]) return KNOWN_SITES[key];
    if (key.length < 6) return null;
    let best = null, bestD = 99;
    for (const k of Object.keys(KNOWN_SITES)) {
      const dd = distance(key, k);
      if (k.length >= 6 && dd < bestD + 1 && dd <= Math.floor(k.length / 4) && (best == null || dd < bestD)) {
        best = k;
        bestD = dd;
      }
    }
    return best ? KNOWN_SITES[best] : null;
  }
  var isKnownSite = (name) => Boolean(knownSite(name)) || Boolean(gameUrl(name));
  var GAMES = {
    // Free every day (NYT's Mini now needs a subscription): resolved to today's puzzle number.
    crossword: "latest:guardian-quick",
    "quick crossword": "latest:guardian-quick",
    "guardian crossword": "latest:guardian-quick",
    "mini crossword": "https://www.nytimes.com/crosswords/game/mini",
    "the mini": "https://www.nytimes.com/crosswords/game/mini",
    wordle: "https://www.nytimes.com/games/wordle/index.html",
    connections: "https://www.nytimes.com/games/connections",
    "spelling bee": "https://www.nytimes.com/puzzles/spelling-bee",
    strands: "https://www.nytimes.com/games/strands",
    sudoku: "https://www.nytimes.com/puzzles/sudoku/easy",
    chess: "https://lichess.org/",
    2048: "https://play2048.co/",
    "cookie clicker": "https://orteil.dashnet.org/cookieclicker/",
    "spend bill gates money": "https://neal.fun/spend/",
    akinator: "https://en.akinator.com/"
  };
  var squash = (s) => s.toLowerCase().replace(/^(the|a|some|play|a game of)\s+/g, "").replace(/\s+game$/, "").replace(/[^a-z0-9]/g, "").replace(/s$/, "");
  function gameUrl(name) {
    const k = squash(name);
    if (!k) return null;
    for (const [g, url] of Object.entries(GAMES)) if (squash(g) === k) return url;
    return null;
  }
  function looksLikeUrl(s) {
    return /^(https?:\/\/|localhost|[\w-]+(\.|\s+dot\s+)(com|org|net|edu|io|dev|ai|app|gov|co|me)\b)/i.test(s.trim());
  }

  // js/core-entry.ts
  var norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  function fuzzyScore(query, candidate) {
    const q = norm(query), k = norm(candidate);
    if (!q || !k) return 0;
    if (k === q) return 100;
    if (k.startsWith(q)) return 80;
    if (k.split(" ").some((w) => w.startsWith(q))) return 70;
    if (k.includes(q)) return 60;
    const qw = q.split(" ");
    const hits = qw.filter((w) => k.includes(w)).length;
    return hits ? 40 * (hits / qw.length) : 0;
  }
  function spokenKeys(combo) {
    const names = { cmd: "command", ctrl: "control", alt: "option", return: "enter" };
    return combo.split("+").map((k) => names[k] ?? k).join(" ");
  }
  return __toCommonJS(core_entry_exports);
})();
