// Claude's jobs in nyxOS:
//   1. operator()       — interpret a free-form utterance into concrete UI steps (tool use).
//                         Haiku answers first and escalates to the strong model when needed.
//   2. narrateScreen()  — decide what on screen is worth reading, given what the user is doing
//   3. spokenToCode()   — "const x equals five" → `const x = 5;`
//   4. summarizeUnread()— triage unread messages into a 10-second spoken brief
//
// Design rule: Claude is the user's hands, not their replacement. It performs the
// step that was asked and stops. It never decides on its own to send, delete, or
// submit something the user didn't explicitly say.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.anthropicKey }));

export const claudeAvailable = () => Boolean(config.anthropicKey);

// Server-side fallback: if a request is declined by a safety classifier, the API
// re-runs it on the appropriate fallback model instead of returning nothing.
const BASE = () => ({
  betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: 'default' as const,
});

/**
 * Last line of defense against reasoning being read aloud ("The user said X... I should ask...").
 * If a reply narrates instead of speaking to the user, keep only its final sentence, which is
 * the question or answer meant for them.
 */
export function spokenOnly(text: string): string {
  const t = text.trim();
  const reasoning = /\b(the user|user said|user's|i should|i need to|i'll need|let me|actually,|the rules say|recent context|previous turn|my last|i asked)\b/i;
  if (!reasoning.test(t)) return t;
  // Keep the sentences meant for the user; drop the ones narrating the reasoning.
  const sentences = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [t];
  return sentences.map((s) => s.trim()).filter((s) => s && !reasoning.test(s)).join(' ');
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
}

const SPOKEN_STYLE = `Everything you write is spoken by a text-to-speech voice to a blind user at 2x speed or faster. Every word costs them time, so speak like a terse co-pilot, not an assistant.
- Telegraphic. Fragments are fine. Aim for under 12 words; never more than two short sentences.
- Result first. No preamble, no "Sure", "I've", "I'll", "Let me", "for you", no restating the request, no offers of further help.
- Drop articles and filler. Say "Amazon, results for fridge magnets." not "I've searched Amazon for fridge magnets for you."
- Lists: a few options as plain words, no numbers: "Inbox, Drafts, Sent, and 4 more." At most 5; labels of 1 to 3 words.
- No markdown, emoji, URLs, or code fences.
- Unsure? Say so in a few words instead of guessing.
- Verbosity (given in the context): brief means under 8 words and at most 3 list items; detailed allows up to 3 sentences and 8 items. "Tell me more" expands only the last answer.
- Never say your reasoning, plans, or rules ("I should confirm", "this is destructive, ask first"). Only what the user should hear: to confirm, just ask, e.g. "Wipe your save? It can't be undone."`;

// ---------------------------------------------------------------- operator

export interface ToolSpec { name: string; description: string; input_schema: Anthropic.Beta.BetaTool['input_schema'] }

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

export const OPERATOR_TOOLS: ToolSpec[] = [
  { name: 'list_windows', description: 'List open windows across all apps, numbered.', input_schema: obj({}) },
  { name: 'focus_window', description: 'Switch to a window by its number from the last list_windows result.', input_schema: obj({ number: int('1-based') }, ['number']) },
  { name: 'open_app', description: 'Open or switch to an application by name.', input_schema: obj({ name: str('App name, e.g. "Visual Studio Code", "Messages"') }, ['name']) },
  { name: 'open_url', description: 'Open a URL in the Lens browser (built-in de-bloated browser).', input_schema: obj({ url: str('URL or domain') }, ['url']) },
  { name: 'site_search', description: 'Search within the website open in the Lens, using its own search box (e.g. products on Amazon). Prefer this whenever a site is open.', input_schema: obj({ query: str('query') }, ['query']) },
  { name: 'web_search', description: 'Search the whole web (DuckDuckGo) in the Lens browser. Only when no site is open, or the user says web or google.', input_schema: obj({ query: str('query') }, ['query']) },
  { name: 'escalate', description: 'Hand this request to a stronger model. Decide at once, as your first call: escalate when the request needs multi-step reasoning, reading or changing code, comparing or summarizing many things, or you cannot tell what the user means. Do it yourself for simple steps: open, click, search, go back, read a value.', input_schema: obj({ reason: str('a few words') }, ['reason']) },
  { name: 'web_outline', description: 'Get the structure of the current Lens page: regions, headings, links (with prices when shown), inputs, buttons with ids. Pass a query to get every item mentioning it, e.g. "price|under|sort" to find filters and sort menus.', input_schema: obj({ query: { type: ['string', 'null'], description: 'words to match, separated by |; null for the whole page' } }, ['query']) },
  { name: 'filter_results', description: 'Narrow or sort the current result list by the prices already shown, and read it out. Use when the site has no usable filter of its own, or to answer "cheapest" from the list.', input_schema: obj({ max_price: { type: ['number', 'null'] }, min_price: { type: ['number', 'null'] }, sort: { type: 'string', enum: ['price_low', 'price_high', 'none'] }, contains: { type: ['string', 'null'], description: 'words the item name must include' } }, ['max_price', 'min_price', 'sort', 'contains']) },
  { name: 'web_find', description: 'Find text on the current Lens page: returns the visible text of the blocks that mention the words (prices, ratings, sizes, delivery dates). Use for questions about what a page says.', input_schema: obj({ query: str('words to look for, e.g. the product name') }, ['query']) },
  { name: 'web_screenshot', description: 'See a screenshot of the current Lens page, as a last resort when the text tools (web_outline, web_find) can\'t answer, or to locate something to click by position. zoom_out shows about twice as much (a whole game board) but can\'t be used for web_click_point.', input_schema: obj({ zoom_out: { type: ['boolean', 'null'] } }, ['zoom_out']) },
  { name: 'web_look', description: 'Look at the picture of one post, product or card, found by its text (e.g. the post title). Scrolls it into view and returns a small cropped image: much faster than web_screenshot. Use it whenever an item is mostly a picture.', input_schema: obj({ text: str('distinctive text of the post or item, e.g. its title') }, ['text']) },
  { name: 'web_read_data', description: 'Read a value from the page\'s own JavaScript data, read-only, when the screen only shows icons or hides it (e.g. Cookie Clicker: Game.Achievements["Tabloid addiction"].won, Game.cookies). One expression; no assignments, clicks, storage, or network. Not available on sign-in or payment pages.', input_schema: obj({ expression: str('a read-only JavaScript expression') }, ['expression']) },
  { name: 'web_comments', description: 'The comments on the current post or article, in order, with author and points (10 at a time). Use for "read the comments", "what do people say".', input_schema: obj({ from: { type: ['integer', 'null'], description: '0-based start, default 0' } }, ['from']) },
  { name: 'web_wait', description: 'Wait for the Lens page to change: until some text appears (e.g. "Continue", a game board word) or disappears (e.g. "Loading", an ad countdown), up to 45 seconds. Use for ads, loading screens and animations instead of retrying clicks.', input_schema: obj({ appears: { type: ['string', 'null'] }, disappears: { type: ['string', 'null'] }, seconds: { type: ['integer', 'null'], description: 'max wait, default 20' } }, ['appears', 'disappears', 'seconds']) },
  { name: 'web_scroll', description: 'Scroll the Lens page to reveal more (lists, feeds, long pages). Returns how far down you are.', input_schema: obj({ direction: { type: 'string', enum: ['down', 'up'] }, screens: { type: ['integer', 'null'], description: 'how many screens, default 1' } }, ['direction', 'screens']) },
  { name: 'web_hover', description: 'Hover over an element (by visible text, or a point on the last web_screenshot) to reveal its tooltip, e.g. icon grids whose names only show on hover.', input_schema: obj({ text: { type: ['string', 'null'] }, x: { type: ['integer', 'null'] }, y: { type: ['integer', 'null'] } }, ['text', 'x', 'y']) },
  { name: 'web_select', description: 'Make exactly these tiles the selection in a tile game (Connections): clears any other selected tiles, keeps already-selected ones, selects the rest, and optionally presses Submit and reports the result. Use this instead of web_activate for tiles; never toggle tiles one by one.', input_schema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'tile ids from the Choices list' }, submit: { type: 'boolean' } }, ['ids', 'submit']) },
  { name: 'web_type', description: 'Type keys into the Lens page where focus is (a crossword cell, Wordle), for games and widgets with no text field. Select the target first (click a clue or cell).', input_schema: obj({ text: str('letters to type; use web_activate or press_keys for Enter/Backspace') }, ['text']) },
  { name: 'web_click_text', description: 'Click the element showing this visible text, even if it is not a link or button (game counters, news tickers, custom widgets). Supports repeats and click-until.', input_schema: obj({ text: str('exact visible text, or a distinctive part of it (from web_find)'), times: { type: ['integer', 'null'], description: 'repeat count, else null' }, until: { type: ['string', 'null'], description: 'keep clicking (up to 100) until this text newly appears on the page, e.g. "Achievement unlocked"; else null' } }, ['text', 'times', 'until']) },
  { name: 'web_click_point', description: 'Click at a point on the last web_screenshot, in that image\'s pixel coordinates. Use when the target has no text to click by (icons, canvas). Supports repeats and click-until.', input_schema: obj({ x: int('x in screenshot pixels'), y: int('y in screenshot pixels'), times: { type: ['integer', 'null'], description: 'repeat count, else null' }, until: { type: ['string', 'null'], description: 'keep clicking until this text newly appears, else null' } }, ['x', 'y', 'times', 'until']) },
  { name: 'web_activate', description: 'Click a link or button, or focus an input, on the Lens page by id. For repeated clicks ("click the cookie 15 times") pass times in ONE call; never call this repeatedly for the same element.', input_schema: obj({ id: str('item id from web_outline'), times: { type: ['integer', 'null'], description: 'repeat count for repeated clicks, else null' } }, ['id', 'times']) },
  { name: 'web_fill', description: 'Type text into a Lens page input by id.', input_schema: obj({ id: str('input id'), text: str('text') }, ['id', 'text']) },
  { name: 'editor_state', description: 'Current code editor state: file, line, column, line text, error counts.', input_schema: obj({}) },
  { name: 'go_to_line', description: 'Move the editor cursor to a line.', input_schema: obj({ line: int('1-based line') }, ['line']) },
  { name: 'read_lines', description: 'Read lines from the current file.', input_schema: obj({ from: int('first line'), to: int('last line') }, ['from', 'to']) },
  { name: 'diagnostics', description: 'List errors and warnings in the current file.', input_schema: obj({}) },
  { name: 'insert_text', description: 'Insert text at the cursor (editor) or type into the focused field (any app).', input_schema: obj({ text: str('literal text to insert') }, ['text']) },
  { name: 'replace_line', description: 'Replace the full text of one line in the current file.', input_schema: obj({ line: int('1-based'), text: str('new line text, including indentation') }, ['line', 'text']) },
  { name: 'press_keys', description: 'Press a keyboard shortcut in the frontmost app, e.g. "cmd+s", "return", "ctrl+g".', input_schema: obj({ keys: str('keys joined with +') }, ['keys']) },
  { name: 'read_screen', description: 'Not for the Lens (use the web_ tools there). Get a text transcription of the frontmost native app window (accessibility tree, or vision if the tree is sparse). Element paths in {braces} can be pressed.', input_schema: obj({}) },
  { name: 'press_element', description: 'Press/click/focus a UI element by its {path} from read_screen.', input_schema: obj({ path: str('e.g. 0.3.1') }, ['path']) },
  { name: 'unread_messages', description: 'Fetch unread iMessages/SMS.', input_schema: obj({}) },
  { name: 'send_message', description: 'Send an iMessage. Only when the user explicitly asked to send this exact content.', input_schema: obj({ to: str('contact name, phone, or email'), text: str('message') }, ['to', 'text']) },
];

const OPERATOR_SYSTEM = `You are nyxOS, the hands and eyes of a blind computer user. They are fully in charge; you carry out the specific step they ask for, the way a sighted person would do it with mouse and keyboard, then report briefly.

Interpret in context, but don't force it. The user speaks short commands, and speech-to-text often mishears. Use what they are looking at (the Lens page and its links, the editor line, the last spoken list, recent turns) to resolve references ("that", "the first one", "the picture") and to repair misheard words that clearly fit the page (on a shopping site "each magnets" is most likely "search magnets").
- A request unrelated to the current page is its own thing: "go to CS70 lecture notes" while on Amazon means find that on the web (open_url with the name, or web_search), not search Amazon. Never ask "Amazon or the web?" for something that is obviously not on Amazon.
- If a request fits neither the page nor a clear action, ask one short question instead of guessing. A short answer to your own question ("web", "yes", "the second") continues that question.
- On a website with a search box, a bare product, topic, or name means search that site: use site_search, not web_search.
- A phrase that names a link, button, or field on the page means activate it (web_activate, after web_outline if you need ids).
- A phrase that names an item from the last spoken list means that item.
- Only use web_search when no site is open or they say web or google.
- Searches with conditions ("protein powder under $20", "best rated headphones", "cheapest one"): search for the plain product (site_search "protein powder"), never the literal sentence. Then apply the condition with the site's own controls: web_outline with a query like "under|price|min|max|go|sort|stars" finds price filter links (e.g. "Up to $25"), Min/Max price fields, and the sort menu; use web_activate, or web_fill then the Go button. If the site has no usable control, use filter_results on the list. Finish by reading the narrowed results.
- "Cheapest" or "most expensive" of what was just read: answer from the prices in the last spoken list, or use filter_results to sort.
- "Click", "open", or "select" X means activate it with web_activate. Never just read X's label back.
- If X isn't in web_outline (plain text the page listens to, like a news ticker or a counter), don't give up or offer something else: find its text with web_find and use web_click_text, or take a web_screenshot and use web_click_point on where it is ("the thing at the top middle").
- "Until" requests ("click the ticker until I get an achievement") use the until parameter in one call, not many calls. Until counts only new appearances, so text already on screen doesn't matter; just start.
- Don't give up after one look. If something isn't visible, scroll (web_scroll) and look again, try web_find with other words, hover icons for tooltips (web_hover), or look at the screen. Only say you can't after trying.
- Be satisfied only when the user would be. A post or item whose text alone doesn't say what it is (an image post, "what is this?", a meme, a product photo) needs web_look on it, without being asked.
- "Next post" / "previous post" mean the one after or before the post discussed last in the feed or list it came from, never a web search and never a "related posts" link. If you are on a single post's page that was opened from a feed (see "Came from"), go back (press_keys is not needed: use open_url with the feed's URL) and open the following post there.
- "The picture", "it", "that post" mean the item discussed last (see Recent), e.g. after "what's the next post", "what's the picture" means that next post's picture: web_look it by its title.
- Harmless clicks (games, menus, links, tickers) need no confirmation: do them. Confirm only before sending, buying, deleting, or submitting personal data.
- "This", "that", "it", "the item" refer to what was last spoken about or opened (see Recent).
- Answer the question that was asked: "how much" means the price in money. Look it up with web_find, then web_screenshot if the text lacks it.
- Be quick: use the fewest steps. The page's HTML is the source of truth: prefer web_outline (with a query), web_find, web_comments; they cover the whole page, not just what's scrolled into view, so there's no need to scroll or screenshot to "see the rest". A click's result already lists what appeared (e.g. a dialog's "Yes"), so don't re-read the page after it. Screenshots are the last resort.
- Never reload, re-open, or navigate away from a game in progress (open_url, back): that throws away the player's progress. Fix problems in place.
- Tiles listed under Choices are checkboxes: select them with ONE web_select call (ids, submit true/false). Never web_activate, web_click_text or web_click_point on tiles; clicking toggles.
- Crosswords: select a clue by clicking it in the clue list (web_click_text with the clue text), then web_type the answer; read clues with web_find "across" / "down".
- Game boards and word grids (Connections, Wordle): the tiles are usually already in the context (Choices, Buttons). If the context answers the question, answer directly without any tool call.
- Finish what you were asked: after confirming a destructive step with the user ("Yes"), carry it through every dialog to the end.

Questions get answers. When the request is a question or a goal with an answer (fact check, look up, when/what/who/how much, is it true, compare), carry it through and end with the answer in a sentence or two, naming the source: search, open the best source (prefer authoritative ones), read it with web_find, answer. "Fact check this" refers to the claim just spoken (see Recent): say whether it holds up and what the source says. A results list is not an answer.
If a source is behind a security check: wait briefly with web_wait for an automatic check; if a human challenge (CAPTCHA) remains, never try to solve it; use another source.

Rules:
- Do exactly the step requested, not the whole project. "Fix the bug" is a request to help them find it, not to rewrite their code silently. Prefer navigation and reading over large edits.
- Use the fewest tool calls. If the request is one action, make one call.
- Never send a message, delete anything, submit a form with payment, or close unsaved work unless the user explicitly asked for that action in this request. If they asked you to send something you composed yourself, read it back and ask first.
- After acting, say what changed in a few words, e.g. "Line 42: return total." If something failed, say what failed and one next step, briefly.
- If the request is truly ambiguous, ask one short question: "Amazon or the web?"
- If a tool result already ends with a spoken summary, don't repeat it; add at most a few words.

${SPOKEN_STYLE}`;

const FAST = { thinking: { type: 'disabled' as const } };

const STRICT_TOOLS = new Set(['escalate', 'focus_window', 'open_app', 'open_url', 'site_search', 'web_search', 'web_activate', 'web_fill', 'web_click_text', 'web_click_point', 'filter_results', 'go_to_line', 'insert_text', 'replace_line', 'press_keys', 'press_element', 'send_message', 'read_lines']);

export type ToolResult = string | Anthropic.Beta.BetaToolResultBlockParam['content'];
export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<ToolResult>;

/** `finished` returns a spoken result once a tool has fully answered the request (e.g. a page opened and summarized). */
// Every cache entry here lives an hour (warmed at startup and every 50 minutes): a spoken
// command should never wait on a cold prompt. Cost doesn't matter here; latency does.
const CACHE = { type: 'ephemeral' as const, ttl: '1h' as const };

/** The operator request for a model: identical bytes for real calls and warm-ups. */
// Room for thinking plus the reply: a puzzle question can think for a while before answering.
function operatorRequest(model: string, messages: Anthropic.Beta.BetaMessageParam[], maxTokens = 16000) {
  return {
    ...BASE(),
    model,
    max_tokens: maxTokens,
    output_config: { effort: config.claudeEffort },
    // Thinking stays on here: without it Haiku writes its reasoning as the reply, and that
    // would be read aloud. (The one-shot calls below run without it; their output is constrained.)
    system: [{ type: 'text' as const, text: OPERATOR_SYSTEM, cache_control: CACHE }],
    // Strict schemas where a malformed input would do the wrong thing (the API allows at most 20).
    tools: OPERATOR_TOOLS.filter((t) => t.name !== 'escalate' || model === config.claudeFastModel)
      .map((t) => ({ ...t, strict: STRICT_TOOLS.has(t.name) })),
    // Automatic breakpoint on the growing tail: each step of a multi-step task reuses the last.
    cache_control: CACHE,
    messages,
  };
}

/** Write the instruction caches before the first command (max_tokens 0: prefill only, no output). */
export async function warmCaches(): Promise<void> {
  if (!claudeAvailable()) return;
  const ping: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'warm-up' }];
  await Promise.all([config.claudeFastModel, config.claudeModel].map((m) =>
    anthropic().beta.messages.create({ ...operatorRequest(m, ping, 0), cache_control: undefined } as never).catch(() => undefined)));
}

/** Splits streamed text into sentences as they complete ("$28.69" and "e.g" don't end one). */
function sentenceSplitter(emit: (s: string) => void) {
  let buf = '';
  const reasoning = /\b(the user|user said|i should|i need to|the rules say|recent context|previous turn)\b/i;
  const out = (s: string) => { const t = s.trim(); if (t && !reasoning.test(t)) emit(t); };
  return {
    push(text: string) {
      buf += text;
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/^([\s\S]*?[.!?…])(\s+)(?=[A-Z0-9"'“(])/))) { out(m[1]); buf = buf.slice(m[0].length); }
    },
    flush() { out(buf); buf = ''; },
  };
}

export async function operator(utterance: string, context: string, runTool: ToolRunner, onStep?: (name: string, ms?: number) => void, finished?: () => string | null, cancelled?: () => boolean, onSentence?: (s: string) => void): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: `${context}\n\nUser said: "${utterance}"` },
  ];
  // Fast model first; it calls escalate when the request needs the strong one. The strong
  // model continues the same conversation (it reads the fast model's thinking blocks).
  let model = config.claudeFastModel;
  let askedForAnswer = false;
  // No "give up and ask the user how the UI works": if the fast model hasn't finished in a few
  // steps, the strong model takes over and keeps going. The cap only guards against loops.
  const MAX_STEPS = 40;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (cancelled?.()) return '';
    if (step === 6 && model === config.claudeFastModel) {
      model = config.claudeModel;
      onStep?.('escalate (taking longer than expected)');
      const last = messages[messages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: 'You are now the stronger model, taking over because this is taking several steps. Look at what was tried, work out what is actually blocking (an ad timer, a loading screen, a hidden control, the wrong element), and finish the request. Use web_wait for things that need time.' });
      }
    }
    const callStart = Date.now();
    // Streamed: a reply's sentences go to speech as they're written. A turn that turns out to
    // call a tool stops speaking at that point (its text was a preamble, not the answer).
    const stream = anthropic().beta.messages.stream(operatorRequest(model, messages));
    let toolStarted = false;
    const split = onSentence ? sentenceSplitter(onSentence) : null;
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') toolStarted = true;
      else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && !toolStarted && split && !cancelled?.()) split.push(ev.delta.text);
    });
    const res = await stream.finalMessage();
    if (!toolStarted && res.stop_reason !== 'tool_use') split?.flush();
    if (process.env.NYX_SCRIPT) console.log(`[timing] ${model} call ${step}: ${Date.now() - callStart}ms, in ${res.usage.input_tokens}+${res.usage.cache_read_input_tokens ?? 0}cached, out ${res.usage.output_tokens}`);
    if (res.stop_reason === 'refusal') return "I can't help with that one.";
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use' || !toolUses.length) {
      const said = spokenOnly(textOf(res.content));
      if (said) return said;
      // Nothing sayable: it ran out of room while thinking, or wrote only reasoning. Never answer
      // with a bare "Done."; ask once more for the answer itself (on the strong model).
      if (!askedForAnswer) {
        askedForAnswer = true;
        model = config.claudeModel;
        messages.push({ role: 'user', content: 'Answer the user now, in one or two short spoken sentences: the answer itself, with no reasoning. If you are unsure, give your best guess and say it is a guess.' });
        continue;
      }
      return "I couldn't work that one out.";
    }

    // One at a time, in order: these are clicks and keystrokes on a real screen.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      if (t.name === 'escalate') {
        model = config.claudeModel;
        onStep?.(`escalate (${String((t.input as { reason?: string }).reason ?? '')})`);
        results.push({ type: 'tool_result', tool_use_id: t.id, content: 'Escalated. You are now the stronger model; carry out the request.' });
        continue;
      }
      const t0 = Date.now();
      try {
        results.push({ type: 'tool_result', tool_use_id: t.id, content: await runTool(t.name, t.input as Record<string, unknown>) });
        onStep?.(t.name, Date.now() - t0);
      } catch (e) {
        onStep?.(`${t.name} failed`, Date.now() - t0);
        results.push({ type: 'tool_result', tool_use_id: t.id, content: `Error: ${(e as Error).message}`, is_error: true });
      }
    }
    const done = finished?.();
    if (done && !results.some((r) => r.is_error)) return done;
    messages.push({ role: 'user', content: results });
  }
  // Only reached after 40 steps: say what's in the way in plain words, not how to drive the UI.
  const lastText = [...messages].reverse().flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => (b as { type: string }).type === 'text') as { text?: string } | undefined;
  return spokenOnly(lastText?.text ?? '') || "I couldn't finish that; the page isn't responding the way it should.";
}

// ---------------------------------------------------------------- screen narration

export interface Narration { speak: string; options: Array<{ label: string; path: string | null }> }

const NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    speak: { type: 'string', description: 'What to say aloud: one short telegraphic sentence, under 15 words.' },
    options: {
      type: 'array',
      description: 'Up to 5 places the user could go or act next, most useful first.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '1-3 word spoken label' },
          path: { type: ['string', 'null'], description: 'Element {path} from the tree if pressable, else null' },
        },
        required: ['label', 'path'],
        additionalProperties: false,
      },
    },
  },
  required: ['speak', 'options'],
  additionalProperties: false,
};

export async function narrateScreen(screen: string, goal: string | undefined, recent: string): Promise<Narration> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: NARRATION_SCHEMA } },
    system: [{ type: 'text', cache_control: CACHE, text: `You decide what a blind user needs to hear about their screen right now. Do not read everything. Read hierarchically:
first where they are (app, window, focused element), then the few regions that matter for what they are doing, then offer numbered places to go.
Prioritize: errors, dialogs and alerts, the focused element, new or changed content, then navigation targets. Skip decorative and repeated chrome.
${SPOKEN_STYLE}` }],
    messages: [{
      role: 'user',
      content: `Recent activity:\n${recent || '(none)'}\n\nUser's current goal: ${goal || 'orient me'}\n\nScreen:\n${screen}`,
    }],
  });
  try {
    return JSON.parse(textOf(res.content)) as Narration;
  } catch {
    return { speak: textOf(res.content) || "I couldn't make sense of the screen.", options: [] };
  }
}

// ---------------------------------------------------------------- spoken code

export async function spokenToCode(spoken: string, languageId: string, surrounding: string): Promise<string> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeModel,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: `Convert dictated code into the literal source text to insert at the cursor. Language: ${languageId}.
Output ONLY the code, no fences, no explanation. Transcribe what was said; do not add logic that was not dictated.
Match the indentation and style of the surrounding code. "equals" is =, "double equals" ==, "triple equals" ===, "open paren" (, "new line" is a line break, "end" closes the current block if the language needs it.`,
    messages: [{ role: 'user', content: `Surrounding code (cursor at ▮):\n${surrounding}\n\nDictated: ${spoken}` }],
  });
  return textOf(res.content).replace(/^```\w*\n?|\n?```$/g, '');
}

// ---------------------------------------------------------------- messages triage

export async function summarizeUnread(digest: string): Promise<string> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 1500,
    output_config: { effort: 'low' },
    system: `Brief a blind user on their unread messages in under 10 seconds of speech.
Start with the count of people. Then, most urgent first, one short clause per conversation: who, and what they need. Quote short messages verbatim. Group noise (codes, promos) into one clause at the end. No closing instructions.
${SPOKEN_STYLE}`,
    messages: [{ role: 'user', content: digest }],
  });
  return textOf(res.content);
}

// ---------------------------------------------------------------- first glance at a page

export interface Glance { speak: string; look: string | null; options: Array<{ label: string; id: string }> }

const GLANCE_SCHEMA = {
  type: 'object',
  properties: {
    speak: { type: 'string', description: 'The main content, as a sighted eye would land on it. Under 35 words. Never lists the options: they are read out after it.' },
    look: { type: ['string', 'null'], description: 'If the main post or item is a picture whose title does not say what it shows, its exact title (so its picture gets described next); else null.' },
    options: {
      type: 'array',
      description: 'Up to 5 next places, most useful first.',
      items: {
        type: 'object',
        properties: { label: { type: 'string', description: '1-3 words' }, id: { type: 'string', description: 'item id from the page list' } },
        required: ['label', 'id'],
        additionalProperties: false,
      },
    },
  },
  required: ['speak', 'look', 'options'],
  additionalProperties: false,
};

/** What a sighted person would notice first on a page: the top post, the score, the headline. */
/**
 * Reads the "speak" string out of a JSON reply as it streams, so the glance can be spoken
 * sentence by sentence before the options (which come after it) are written.
 */
function speakFieldStream(emit: (s: string) => void) {
  let raw = '', i = -1, done = false;
  const split = sentenceSplitter(emit);
  return {
    push(t: string) {
      if (done) return;
      raw += t;
      if (i < 0) { const m = raw.match(/"speak"\s*:\s*"/); if (!m) return; i = (m.index ?? 0) + m[0].length; }
      let out = '';
      while (i < raw.length) {
        const c = raw[i];
        if (c === '\\') { if (i + 1 >= raw.length) break; const n = raw[i + 1]; out += n === 'n' ? ' ' : n === 'u' ? (i + 5 < raw.length ? String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)) : '') : n; i += n === 'u' ? 6 : 2; continue; }
        if (c === '"') { done = true; i++; break; }
        out += c; i++;
      }
      if (out) split.push(out);
      if (done) split.flush();
    },
  };
}

export async function firstGlance(digest: string, onSentence?: (s: string) => void): Promise<Glance> {
  const stream = anthropic().beta.messages.stream({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 1500,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: GLANCE_SCHEMA } },
    system: [{ type: 'text', cache_control: CACHE, text: `You give a blind user the first glance at a web page they just opened, the way a sighted person's eye lands on it.
Say the main content first: what the top post is actually about (title, community or author, picture or video), a game's score and key numbers, an article's headline, a product and its price, the newest message.
On a single post or article page: the post itself, then the top comment in one short clause if it adds something. Skip the comment if unsure; compact beats complete.
Never mention ads, promoted or sponsored posts, cookie banners or "Got it" / "Accept" buttons, sign-in, subscribe or upgrade prompts, newsletters, app downloads, menus, or account buttons, and never offer them as options. Options are content: posts, sections, the comments, key controls (a game's big button, a store).
Start with the site name. Telegraphic, under 35 words (under 15 if Verbosity is brief, up to 60 if detailed). Lead with what is most visually prominent. Then up to 5 options with ids from the page list, in the options field only: they are read out after speak, so speak never lists them or says "Options".
No offers or questions back ("Want a search?"). If the user has an open question and this page answers it, lead with the answer instead, citing the site (if it doesn't, don't mention the question at all): "Te Ara: Māori arrived around 1250 to 1300, so 1350 is close." If the page is a security or bot check, say it is waiting on a check.
${SPOKEN_STYLE}` }],
    messages: [{ role: 'user', content: digest }],
  });
  const field = onSentence ? speakFieldStream(onSentence) : null;
  stream.on('streamEvent', (ev) => { if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') field?.push(ev.delta.text); });
  const res = await stream.finalMessage();
  try {
    return JSON.parse(textOf(res.content)) as Glance;
  } catch {
    return { speak: textOf(res.content), look: null, options: [] };
  }
}

/** One short line about something new that appeared on screen (a message, a notification). */
export async function summarizeChange(where: string, added: string, recent = ''): Promise<string> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 800,
    output_config: { effort: 'low' },
    system: `Something just changed on a blind user's screen in ${where}. Say it the way a friend looking at the screen would, in under 15 words: who and what for a message ("Sam in general: are we still on for 6?"), the outcome for a game ("Solved: Finish, with close, end, stop, wrap."), the gist for a notification. Normal capitalization, no repeated words, no "New content appeared".
Only say what the text literally states; never infer, extrapolate, or summarize beyond it.
Reply exactly "skip" if it is ads, layout, noise, a list of menu or shop items, or something the user was just told (see Recent).`,
    messages: [{ role: 'user', content: `Recent:\n${recent || '(none)'}\n\nWhat appeared:\n${added.slice(0, 3000)}` }],
  });
  return spokenOnly(textOf(res.content));
}

/** One line about a picture (a cropped post image), for when the title alone doesn't say what it shows. */
export async function describeImage(jpegBase64: string, about: string): Promise<string> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 800,
    output_config: { effort: 'low' },
    system: `Describe this picture for a blind user in under 20 words, starting with "Picture:". Say what it shows and any text in it that matters (a meme's caption, a screenshot's message). ${SPOKEN_STYLE}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `It belongs to: ${about.slice(0, 300)}` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } }] }],
  });
  return textOf(res.content);
}

// ---------------------------------------------------------------- screen recognition

export interface Detected { label: string; kind: string; x: number; y: number }

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      description: 'Interactive things a person could click or tap, most important first (at most 20).',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '1-4 word name a person would use for it' },
          kind: { type: 'string', enum: ['button', 'link', 'field', 'tile', 'toggle', 'image', 'other'] },
          x: { type: 'integer', description: 'center x in image pixels' },
          y: { type: 'integer', description: 'center y in image pixels' },
        },
        required: ['label', 'kind', 'x', 'y'],
        additionalProperties: false,
      },
    },
  },
  required: ['elements'],
  additionalProperties: false,
};

/**
 * Find clickable elements in a screenshot, after Zhang et al., "Screen Recognition" (CHI 2021):
 * when a page draws its controls (a canvas game) or leaves icons unlabeled, the pixels are the
 * only source of truth. Coordinates come back in the image's pixels.
 */
export async function detectElements(jpegBase64: string, width: number, height: number): Promise<Detected[]> {
  const res = await anthropic().beta.messages.create({
    ...BASE(),
    model: config.claudeFastModel,
    ...FAST,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DETECT_SCHEMA } },
    system: [{ type: 'text', cache_control: CACHE, text: 'You find the interactive elements in a screenshot of a web page or game for a blind user: buttons, links, fields, game pieces, icons. Name each the way a person would ("big cookie", "settings gear", "play"). Skip ads. Give each element\'s center in image pixels.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `Image is ${width}x${height} pixels.` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } }] }],
  });
  try { return (JSON.parse(textOf(res.content)) as { elements: Detected[] }).elements ?? []; } catch { return []; }
}
