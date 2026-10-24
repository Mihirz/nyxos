// Claude's jobs in Callbacks:
//   1. operator()       — interpret a free-form utterance into concrete UI steps (tool use)
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

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
}

const SPOKEN_STYLE = `Everything you write is spoken aloud by a text-to-speech voice to a blind user, often at 2x speed.
- One or two short sentences. Lead with the answer. No preamble, no "Sure!", no restating the request.
- No markdown, bullets, emoji, URLs, or code fences. Spell symbols as words only when needed.
- When offering choices, number them: "3 options. 1, Inbox. 2, Drafts. 3, Sent."
- If you are unsure what is on screen, say so plainly rather than guessing.`;

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
  { name: 'web_search', description: 'Search the web in the Lens browser.', input_schema: obj({ query: str('query') }, ['query']) },
  { name: 'web_outline', description: 'Get the structure of the current Lens page: regions, headings, links, inputs, buttons with ids.', input_schema: obj({}) },
  { name: 'web_activate', description: 'Click a link or button, or focus an input, on the Lens page by id.', input_schema: obj({ id: str('item id from web_outline') }, ['id']) },
  { name: 'web_fill', description: 'Type text into a Lens page input by id.', input_schema: obj({ id: str('input id'), text: str('text') }, ['id', 'text']) },
  { name: 'editor_state', description: 'Current code editor state: file, line, column, line text, error counts.', input_schema: obj({}) },
  { name: 'go_to_line', description: 'Move the editor cursor to a line.', input_schema: obj({ line: int('1-based line') }, ['line']) },
  { name: 'read_lines', description: 'Read lines from the current file.', input_schema: obj({ from: int('first line'), to: int('last line') }, ['from', 'to']) },
  { name: 'diagnostics', description: 'List errors and warnings in the current file.', input_schema: obj({}) },
  { name: 'insert_text', description: 'Insert text at the cursor (editor) or type into the focused field (any app).', input_schema: obj({ text: str('literal text to insert') }, ['text']) },
  { name: 'replace_line', description: 'Replace the full text of one line in the current file.', input_schema: obj({ line: int('1-based'), text: str('new line text, including indentation') }, ['line', 'text']) },
  { name: 'press_keys', description: 'Press a keyboard shortcut in the frontmost app, e.g. "cmd+s", "return", "ctrl+g".', input_schema: obj({ keys: str('keys joined with +') }, ['keys']) },
  { name: 'read_screen', description: 'Get a text transcription of the frontmost window (accessibility tree, or vision if the tree is sparse). Element paths in {braces} can be pressed.', input_schema: obj({}) },
  { name: 'press_element', description: 'Press/click/focus a UI element by its {path} from read_screen.', input_schema: obj({ path: str('e.g. 0.3.1') }, ['path']) },
  { name: 'unread_messages', description: 'Fetch unread iMessages/SMS.', input_schema: obj({}) },
  { name: 'send_message', description: 'Send an iMessage. Only when the user explicitly asked to send this exact content.', input_schema: obj({ to: str('contact name, phone, or email'), text: str('message') }, ['to', 'text']) },
];

const OPERATOR_SYSTEM = `You are Callbacks, the hands and eyes of a blind computer user. They are fully in charge; you carry out the specific step they ask for, the way a sighted person would do it with mouse and keyboard, then report briefly.

Rules:
- Do exactly the step requested, not the whole project. "Fix the bug" is a request to help them find it, not to rewrite their code silently. Prefer navigation and reading over large edits.
- Use the fewest tool calls. If the request is one action, make one call.
- Never send a message, delete anything, submit a form with payment, or close unsaved work unless the user explicitly asked for that action in this request. If they asked you to send something you composed yourself, read it back and ask first.
- After acting, say what changed in a few words, e.g. "VS Code, line 42: return total." If something failed, say what and suggest one next step.
- If the request is ambiguous, ask one short question with numbered options.

${SPOKEN_STYLE}`;

export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<string>;

export async function operator(utterance: string, context: string, runTool: ToolRunner, onStep?: (name: string) => void): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: `${context}\n\nUser said: "${utterance}"` },
  ];
  for (let step = 0; step < 8; step++) {
    const res = await anthropic().beta.messages.create({
      ...BASE(),
      model: config.claudeModel,
      max_tokens: 4000,
      output_config: { effort: config.claudeEffort },
      system: [{ type: 'text', text: OPERATOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: OPERATOR_TOOLS.map((t) => ({ ...t, strict: true })),
      messages,
    });
    if (res.stop_reason === 'refusal') return "I can't help with that one.";
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use' || !toolUses.length) return textOf(res.content) || 'Done.';

    const results = await Promise.all(
      toolUses.map(async (t): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        onStep?.(t.name);
        try {
          return { type: 'tool_result', tool_use_id: t.id, content: await runTool(t.name, t.input as Record<string, unknown>) };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: t.id, content: `Error: ${(e as Error).message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: 'user', content: results });
  }
  return 'That took too many steps, so I stopped. Tell me the next step.';
}

// ---------------------------------------------------------------- screen narration

export interface Narration { speak: string; options: Array<{ label: string; path: string | null }> }

const NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    speak: { type: 'string', description: 'What to say aloud, 1-3 short sentences.' },
    options: {
      type: 'array',
      description: 'Up to 7 places the user could go or act next, most useful first.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '2-5 word spoken label' },
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
    model: config.claudeModel,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: NARRATION_SCHEMA } },
    system: `You decide what a blind user needs to hear about their screen right now. Do not read everything. Read hierarchically:
first where they are (app, window, focused element), then the few regions that matter for what they are doing, then offer numbered places to go.
Prioritize: errors, dialogs and alerts, the focused element, new or changed content, then navigation targets. Skip decorative and repeated chrome.
${SPOKEN_STYLE}`,
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
    model: config.claudeModel,
    max_tokens: 1500,
    output_config: { effort: 'low' },
    system: `Brief a blind user on their unread messages in under 15 seconds of speech.
Start with the count of people. Then, most urgent first, one short clause per conversation: who, and what they need. Quote short messages verbatim. Group noise (codes, promos) into one clause at the end.
Then say: "Say a number to hear a thread, or reply to a name."
${SPOKEN_STYLE}`,
    messages: [{ role: 'user', content: digest }],
  });
  return textOf(res.content);
}
