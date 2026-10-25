# nyxOS for iOS (plan)

Phones are where blind users already live (VoiceOver on iPhone is excellent), but the same linear-navigation problem applies. The port reuses `src/core` unchanged: grammar, braille, narration.

## Approach

- **Expo / React Native app** importing `src/core/*` directly (pure TypeScript, no Node or Electron deps).
- **Voice:** same Cartesia/ElevenLabs endpoints over `fetch`; push-to-talk on a large full-screen button, plus the Action Button shortcut on iPhone 15+.
- **Apps we control fully:** the Lens browser (a `WebView` with the same `EXTRACT_JS`), Messages triage (through an SMS/iMessage-capable backend, since iOS has no chat.db access), and the braille output, which iOS can drive natively via `UIAccessibility` braille when a display is paired.
- **System navigation:** iOS doesn't let third-party apps drive other apps. nyxOS on iOS opens apps through App Intents / Shortcuts ("open Messages", "start a timer") and leaves in-app navigation to VoiceOver. Our value there is the 15-second triage of notifications and messages, the Lens, and the grammar running as Siri-free shortcuts.
- **Shortcodes:** an external keyboard / braille display keyboard works with the same `parseCommand(text, 'typed')`.

## First milestone

1. `npx create-expo-app mobile/app`, path-alias `@core` → `../src/core`.
2. Screen: orb + options list + braille strip (same tokens as desktop CSS).
3. Lens WebView with `EXTRACT_JS`, plus hierarchical options.
4. Cartesia TTS/STT via fetch.
