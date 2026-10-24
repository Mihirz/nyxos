# Callbacks

**A voice-and-keystroke operator for blind and low-vision computer users. You drive; it's your hands and eyes.**

Most "AI agents" take a goal and go do it for you ("build me a website"). That's the wrong shape for someone who just can't see the screen. They don't need a replacement; they need to do the work themselves, at the speed a sighted person does. Callbacks takes the *steps* a sighted user takes with a mouse and keyboard ("open VS Code", "go to line 39", "type this", "click sign up") and runs them instantly. When something is on screen, it tells you what matters, ordered from window to region to item, instead of reading every pixel in order.

> Built at Cal Hacks 13.0 for **blind and low-vision developers and knowledge workers**. Today's screen readers (VoiceOver, NVDA, JAWS) are powerful but linear: reaching one button can take dozens of swipes or memorized key chords. Callbacks lets you say where you want to go.

## What it does

| | |
|---|---|
| **Instant command grammar** | ~60 spoken patterns ("go to line forty two", "open messages", "press command shift p") parsed locally in about 1 ms. No LLM round-trip for the common path. |
| **Touch-type shortcodes** | `g 42`, `o safari`, `t hello`, `s tacos`, `u`, `3`. Faster than speaking when you're in a lecture or on a call. |
| **Hierarchical screen reading** | Windows, then app regions, then content. "Read screen" sends the accessibility tree (or a Gemini vision transcription when the tree is empty) to Claude, which decides what's worth hearing *for what you're doing right now* and offers numbered places to go. |
| **Claude as operator** | Anything the grammar doesn't match goes to Claude with ~20 tools (focus window, go to line, read lines, press keys, click element, web outline…). It's prompted to do the step you asked and stop, not to take over. |
| **Lens browser** | A de-bloated browser built for hierarchical navigation: regions, then headings, links, fields, buttons, all picked by number. A heavy yellow focus ring follows you for low-vision users and sighted helpers. |
| **Editor bridge** | A VS Code/Cursor extension gives exact line numbers, real file contents, diagnostics, and edit events. Screen readers only see a partial textarea. |
| **Follow mode** | Reads back each line as you finish it, new terminal output as it appears, and new errors as they show up. |
| **Unread messages triage** | Reads iMessage/SMS from the local database and briefs you in 15 seconds: who, what they need, most urgent first. Then "reply to Sam saying…". |
| **Braille pipeline** | Every spoken string is also translated to UEB Grade 2 braille and sent to the attached braille drivers. The on-screen 40-cell virtual display is one of them. |
| **Screen curtain + performance mode** | Black out every display (privacy, and proof that nothing relies on pixels). Performance mode fetches web pages as text only: no rendering engine, no JS, no ads. |
| **Speech at screen-reader speed** | Experienced users listen at 2-3×. Cartesia's native speed control plus pitch-preserving playback stacking gets us there. Every new command interrupts speech immediately. Earcons confirm when the mic opens and closes. |

## Sponsor tech, and why each one

- **Anthropic Claude** (`claude-opus-5-5`, low effort for latency): the operator agent (tool use), screen narration (structured JSON output), spoken-code to source, and message triage. Server-side refusal fallbacks are enabled. See [Responsible design](#responsible-design) for where it can go wrong.
- **Cartesia**: default speech-to-text (`ink-whisper`) and text-to-speech (`sonic-3.6`). It's the lowest-latency path, and latency *is* the product for someone waiting on audio to know what happened.
- **ElevenLabs**: drop-in alternate STT (`scribe_v2`) and TTS (`eleven_flash_v2_5`). Set `TTS_PROVIDER=elevenlabs`.
- **Google Gemini**: vision fallback. When an app exposes no accessibility tree (canvas apps, games, images, many Electron apps), Gemini transcribes a screenshot into a structured UI description that Claude then narrates.

## Run it

```bash
npm install
cp .env.example .env          # add whichever keys you have; everything degrades gracefully
npm run build && npm start    # or: npm run dev
npm run bridge:install        # optional: VS Code/Cursor extension for precise editor control
npm run demo:site             # optional: the demo target at http://localhost:3000
npm test                      # grammar + braille unit tests
```

macOS permissions (System Settings → Privacy & Security): **Accessibility** (control apps, read the UI tree), **Microphone**, **Screen Recording** (vision fallback only), **Full Disk Access** (unread messages only). In dev, grant these to your terminal.

**Hotkeys:** `⌥ Space` anywhere toggles listening (auto-stops when you stop talking). `⌥ ⇧ Space` jumps to the typed command bar. In the Callbacks window, hold `Space` to talk, `Esc` to silence, `1`–`9` to pick.

With no keys at all it still works: typed commands, the instant grammar, the Lens, and macOS `say` for speech.

## Architecture

```
src/core/         portable TS: command grammar, braille translator, narration (shared with the iOS port)
src/main/         Electron main: executor (hierarchical nav + dispatch), Claude, Gemini vision,
                  Cartesia/ElevenLabs voice, iMessage, editor bridge client, curtain
native/           axhelper.swift — direct AXUIElement access (~50x faster than AppleScript)
integrations/     vscode-bridge — localhost JSON API over the active editor
src/renderer/     React UI: status orb, numbered options, Lens webview, braille display
demo/             demo target site with a planted bug
mobile/           iOS port plan
```

Every input (voice, shortcode, or Claude tool call) becomes a `Command` and goes through one dispatcher, so the fast path and the AI path behave identically.

## Responsible design

- **The user stays in charge.** Claude is prompted to perform the requested step and stop. It never sends a message, deletes, submits a payment, or closes unsaved work unless that action was explicitly requested in the same utterance, and it reads back anything it composed itself before sending.
- **Honest uncertainty.** Narration says "I think" or "I can't tell" instead of guessing about the screen. A blind user can't verify a confident hallucination.
- **Where it can go wrong:** speech-to-text mishears ("send" vs "end"). Destructive actions go through explicit commands, not inference. Vision models can misread dense UIs, so the accessibility tree is always preferred, and vision output is labeled as such to Claude. Screenshots and message contents leave the device when cloud models are used; performance mode and the instant grammar keep most interaction local.
- **Privacy:** the microphone only records between the start and stop earcons. The editor bridge binds to `127.0.0.1` only. No keys in the repo.

## Known limitations

- macOS only today. The command grammar, braille, and narration in `src/core` are platform-free; see `mobile/README.md` for iOS.
- Grade 2 braille covers common UEB wordsigns and groupsigns, not every contraction rule. Hardware displays need a driver implementing `BrailleDriver` (`src/main/output.ts`); only the virtual display ships.
- Speech-to-text is utterance-based (push-to-talk / VAD), not streaming.
- Performance-mode pages are read-only except for links and GET forms.
