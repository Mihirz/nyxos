# nyxOS for iPhone and iPad

The native iOS app of nyxOS: a voice and typed-shortcode operator for blind and low-vision users.
You drive; it's your hands and eyes. Built with SwiftUI, generated with XcodeGen, and sharing the
desktop app's grammar, narration, braille, page scripts and Claude prompts.

## Run it

Requirements: Xcode 27 (iOS 27 SDK and simulator), XcodeGen (`brew install xcodegen`). Node is
optional (it refreshes the prompts from `src/main/claude.ts`; a committed copy is used otherwise).

```bash
cd ios
scripts/build.sh          # secrets + core bundle + xcodegen + xcodebuild for the simulator
scripts/build.sh run      # ...then boot "iPhone 18 Pro", install and launch
NYX_SIM="iPad Pro 13-inch (M5)" scripts/build.sh run
```

Or open it in Xcode: `cd ios && xcodegen generate && open nyxOS.xcodeproj`, then Run. For a real
device, set your team under Signing (the project ships with signing off for simulator builds).

### On a real iPhone

`scripts/device.sh` builds, installs and runs scripted sessions on a phone over USB or Wi-Fi
(the phone must be unlocked; a free personal team needs the app trusted once in Settings):

```bash
scripts/device.sh build                                  # secrets, core bundle, xcodegen, signed device build
scripts/device.sh install
scripts/device.sh run "o amazon;s protein shakes" 120    # muted; prints the transcript, stops at [script] done
scripts/device.sh all "what is this"                     # build + install + run
```

Defaults are Mihir's iPhone and team; override with `NYX_DEVICE=<udid>` and `NYX_TEAM=<team id>`.
The full console log goes to `build-device/session.log`. Scripted runs keep the last camera photo in the
app container (`xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier
com.nyxos.ios --source Documents/last-look.jpg --destination look.jpg`). The `devicectl --console` process is
killed when the script finishes or times out.

### Keys and config

API keys are never committed. Every build runs `scripts/gen-secrets.sh`, which reads the repo's
`../.env` (read-only) and writes `ios/Config/Secrets.plist` (gitignored) into the app bundle.
Keys used: `ANTHROPIC_API_KEY`, `CLAUDE_FAST_MODEL`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`,
`CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`, `CARTESIA_MODEL`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, `TTS_PROVIDER`, `STT_PROVIDER`. With no keys at all,
typed commands, the instant grammar, the Lens and the iPhone voice still work.

Note: the keys end up inside the built `.app`. That's fine for a hackathon build on your own device;
a shipped app would proxy API calls through a server instead.

### Smoke tests in the simulator

```bash
scripts/build.sh
scripts/sim-test.sh "o amazon;s protein shakes;cheapest one" 60 screenshots/amazon.png
```

It prints the transcript and stops at `[script] done` (second argument: timeout in seconds);
`NYX_SHOT=screenshots/x.png` saves a screenshot at the end. `sim-test.sh` launches with
`-NYX_MUTE YES` (transcript and braille only, no sound) and `-NYX_SCRIPT "cmd;cmd;wait:1500;..."`.
Debugging steps: `eval:<js>` prints the result of JavaScript run in the Lens page, `tap:<data-cb id>`
taps a page element; `-NYX_SEP "%%"` splits steps on `%%` so `eval:` code can contain semicolons.
`-NYX_TAPS script` turns off real taps (see below). `-NYX_LOOK_IMAGE /path/photo.jpg`
stands in for the camera (the simulator has none). `-NYX_TTS device` forces the offline voice.
`-NYX_VOICE_CHECK YES` round-trips a sentence through text-to-speech and back through
speech-to-text, silently, and prints both. A script step `interrupt` acts like pressing Talk
mid-sentence (to test "click that").

Accessibility: `xcodebuild -project nyxOS.xcodeproj -scheme nyxOS -destination "platform=iOS Simulator,name=iPhone 18 Pro" CODE_SIGN_IDENTITY=- test`
runs `nyxOSUITests`, which checks every key control is reachable by its VoiceOver name and runs
Apple's automated accessibility audit on each view.

If your shell has a conda or custom toolchain environment (`CC`, `LD`, `SDKROOT`, ...), unset it
before calling `xcodebuild` directly; `scripts/build.sh` does this for you.

## What's shared with the desktop

| Shared code | How |
|---|---|
| Command grammar, shortcodes (`src/core/commands.ts`) | esbuild bundle run in JavaScriptCore (`nyxOS/Resources/nyxcore.js`) |
| Compact spoken lists, page titles (`src/core/narration.ts`) | same bundle |
| UEB grade 2 braille, `brailleLines` (`src/core/braille.ts`) | same bundle |
| Skimming (`src/core/skim.ts`) | same bundle |
| Lens page scripts: `EXTRACT_JS`, activate, click by text/point, find, look, hover, watch, highlight (`src/renderer/lens/extract.ts`) | same bundle, injected into `WKWebView` |
| URL helpers: known sites, `normalizeUrl`, `looksLikeUrl` (`src/main/web.ts`) | same bundle (performance-mode parser stubbed out) |
| Claude prompts, tool definitions, schemas (`src/main/claude.ts`) | `scripts/extract-prompts.mjs` → `nyxOS/Resources/prompts.json` |

`scripts/bundle-core.sh` regenerates both files and runs on every Xcode build, so grammar and prompt
changes on the desktop flow into the iOS app. If the desktop renames an export, the build keeps
the last good copy and prints a warning.

The executor (`src/main/executor.ts`) is ported to Swift in `nyxOS/Exec/Executor.swift`, function
by function: menus and the menu stack, the Lens (regions, results with prices, one entry per
product card, site search, checkbox tiles, "click A, B and C", choices, comments, skim, screen
recognition, back history that says where it went), first glance, picture description, watch mode,
the message confirm flow with draft edits, "that" after an interruption, the open question/goal,
price answers from what's on screen, and the Claude operator's tools.

## Features

- **Voice.** A huge Talk button: hold to talk, tap for hands-free (stops when you pause). Earcons
  when the mic opens and closes. Pressing Talk stops speech instantly; nothing speaks while you
  hold Talk (replies to what you said play as soon as you let go). A Talk press with no words
  in it is undone, so the reply that was on its way still plays. The status never stays on
  Hearing or Working after a command. Speech-to-text and text-to-speech use Cartesia (`ink-whisper`, `sonic-3.6` mp3,
  `Cartesia-Version: 2026-08-14`), with ElevenLabs switchable ("use ElevenLabs", "switch voice",
  or the Voice menu). A 401/402, or a 429 that mentions credits, falls back (once announced) to the
  next provider and finally to the iPhone voice (`AVSpeechSynthesizer`); a plain 429 retries.
  Speech runs at 1.6× by default ("faster", "slower", the Voice menu). Repeated lines come from a
  cache; replies stream sentence by sentence; ALL-CAPS words are read as words.
- **Instant grammar.** The desktop's ~60 spoken patterns and shortcodes, no AI call.
- **Claude operator.** Raw HTTPS to the Messages API with the desktop's models, prompts and tools:
  Haiku first with an `escalate` tool to Opus, Opus taking over after 6 steps, thinking left on for
  the operator, sentences streamed to speech, 1-hour prompt caching plus warm-up with
  `max_tokens: 0`, server-side refusal fallback, and the `spokenOnly` filter so reasoning is never
  read aloud.
- **Lens browser.** `WKWebView` with the same injected scripts; hierarchical regions; results with
  prices; first glance by Haiku that streams and skips ads, cookie and "Got it" banners and
  account chrome; automatic picture descriptions; watch mode for appended content; the items
  being discussed are outlined on the page; "confirm you're a person" pages are announced, never
  solved or bypassed. Pages lay out at least 390×640 and are scaled to fit, so sites that refuse a
  short window ("Please rotate your device") still work. The on-screen keyboard never opens for
  the page: nyxOS types into it, and typing for you goes through the command bar.
- **Questions get answers.** A question ("when did Louis Braille publish his system") is kept as
  the open question for 5 minutes; the first page that answers it leads with the answer, pages
  that don't never mention it, and it's closed when you go to a new site or app. The operator
  never ends on a bare "Done.": if its last turn says nothing sayable, Opus is asked once more for
  the answer itself.
- **Feeds and lists.** "Next post" / "previous post" go straight to the neighbouring post of the
  feed last read (even from inside a post); other lists use the last item picked. "Show me more
  comments" keeps reading comments. Look-alike options are told apart by their site (DuckDuckGo
  and Google redirects unwrapped), then their own words, then a number.
- **Games.** "Open connections", "go to cross words": game names go to a playable board (today's
  free Guardian quick crossword is resolved from its series page), start-type buttons ("Play",
  "Continue to Connections", "Skip advertisement") are pressed until the board is there.
  Connections: "what are the words", "select those four and submit", "submit those four", "select
  those three plus Möbius", "select the last four": exactly that set becomes the selection (never
  toggling a selected tile off), Submit is pressed and the verdict read. Crosswords: "2 down"
  selects and reads the clue; "type nun" fills each square of that entry. The operator has the
  desktop's `web_select` and `web_type` tools.
- **Look** (iOS only). "What is this?", "what am I looking at?", "read this label", "what color is
  it" take a photo with the camera and answer in a sentence or two (safety first, text read
  exactly, "I think" when unsure, how to retake a blurry shot). The still is taken once frames are
  arriving and exposure and white balance have settled, and retaken once if it comes out
  near-black. In the Lens, "what am I looking at" describes the page from a screenshot instead. In
  the Look view, only questions about the picture ("what color is the cap", "read it", "describe
  it") use the camera; other questions take the normal path (Lens or web).
- **Interruptions.** Cut in during a spoken list and "click that" / "that one" means the item you
  just heard (the iPhone voice reports the exact word; Cartesia/ElevenLabs use playback position).
- **Messages.** "Text Kate saying on my way": the name is looked up in Contacts, the message is read
  back ("Send to Kate Bell: on my way? Say yes, or change a word."), "change way to the way" edits
  it, "yes" opens the Messages sheet filled in, and you tap Send. Nothing is ever sent without
  that tap.
- **Braille.** A virtual 40-cell display (two rows of 20 on a phone) showing a condensed form of
  what's on screen, with the same words in print under the cells and pan controls (VoiceOver:
  swipe up/down on it to pan).
- **Accessibility.** The desktop's night theme (night sky #060a16, starlight text #f3f5ff, star-gold
  #ffd54a, a star field that twinkles only when Reduce Motion is off, gold-glowing braille dots, a
  crescent moon by the wordmark), Atkinson Hyperlegible, thick-stroke icons, Dynamic Type,
  a numbered options list on screen (speech never reads the numbers). Everything has VoiceOver
  labels and traits. The Talk button uses the "starts media session" trait so VoiceOver stays quiet
  while you speak; a two-finger double-tap (Magic Tap) toggles listening from anywhere; the
  two-finger scrub (Escape) stops speech.
- **Hardware keyboard,** whatever has focus (a `UIApplication` subclass sees keys first): hold
  Space to talk, Esc stops, 1–9 pick, Enter runs, and typing anywhere goes to the command bar.
- **Curtain mode** blacks out the app while it keeps working by voice, touch, keys and VoiceOver.
  **Performance mode** fetches pages as text only. **Follow** toggles watch mode. **Discreet** keeps
  names and message text out of speech. Detail level: brief, normal, detailed.

## Braille on iOS

The virtual display is a demo and a helper's view. iOS itself supports refreshable braille
displays natively through VoiceOver (Settings → Accessibility → VoiceOver → Braille, Bluetooth
pairing, grade 2 output and input). Pick **Voice → VoiceOver (and braille)** and nyxOS speaks
through VoiceOver announcements, so every reply also goes to a paired braille display, and every
control in the app is reachable from the display's keys.

## Real taps (private API)

NYT Connections ignores script-made clicks (`event.isTrusted` is false), and `WKWebView` has no
public way to send input. `nyxOS/Native/HIDTap.m` builds the touchscreen's own HID events
(`IOHIDEventCreateDigitizerEvent`, `BKSHIDEventSetDigitizerInfo`, `-[UIApplication
_enqueueHIDEvent:]`), the way WebKit's test runner does, so UIKit hit-tests a real tap and the page
gets a trusted click. Taps wait until the target is the thing under its center and has stopped
moving. Everything is looked up at run time; if a symbol is missing the Lens falls back to script
events. Private API is fine for a hackathon build on your own phone; App Store review would reject
it. The same file keeps the on-screen keyboard closed for the Lens page.

## What iOS doesn't allow, and what the app does instead

| Desktop feature | On iOS |
|---|---|
| Controlling other apps, the window list, keystrokes into any app | Not possible: apps can't drive other apps. "Windows" lists nyxOS's own views (Lens, Look, Home); "open maps/settings/music/mail/calendar" hands off to that app by URL scheme. |
| Reading the macOS accessibility tree / other apps' screens ("read screen" outside the Lens) | Not possible. "Read screen" / "what do you see" outside the Lens uses the **camera** instead. |
| Gemini vision fallback for apps without an accessibility tree | Not needed: no other apps to read. Claude vision covers the camera and the Lens. |
| VS Code bridge, go to line, read line, dictate code | Not possible (no editor or local bridge). Those commands say so. |
| Unread iMessage triage from `chat.db` | Not possible: iOS doesn't let apps read Messages. Sending works via Contacts + the Messages sheet. |
| Global hotkey from any app (⌥ Space) | Not possible. Magic Tap inside the app; the Talk button; Space with a keyboard. |
| Screen curtain over the whole display | The app goes black; for the whole phone use VoiceOver's own Screen Curtain (three-finger triple-tap). |
| macOS `say` | `AVSpeechSynthesizer` (premium/enhanced voice when installed). |

## Layout of the code

```
ios/
  project.yml                XcodeGen spec
  scripts/                   build.sh, device.sh, gen-secrets.sh, bundle-core.sh, extract-prompts.mjs, sim-*.sh, make-icon.swift
  js/core-entry.ts           what gets bundled from ../src
  nyxOS/App                  UIKit lifecycle, keyboard router, scripted runs
  nyxOS/Core                 JavaScriptCore bridge, types, app state
  nyxOS/Voice                Cartesia/ElevenLabs STT+TTS, recorder with VAD, earcons, speech output
  nyxOS/Claude               Messages API client (SSE), operator, glance, look, helpers
  nyxOS/Lens                 WKWebView controller, text-only fetch
  nyxOS/Exec                 the executor (dispatcher)
  nyxOS/Look                 camera
  nyxOS/Native               real taps and keyboard suppression for the Lens (Objective-C, private API)
  nyxOS/Messages             Contacts lookup, Messages composer
  nyxOS/UI                   SwiftUI views
  screenshots/               simulator screenshots
```
