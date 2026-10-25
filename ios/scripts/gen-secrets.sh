#!/bin/bash
# Build-time config: read the repo's .env (never modified) and write a gitignored plist that the
# app bundles. Keys never go into committed files. Missing .env → an empty plist; the app then
# degrades gracefully (typed commands, the instant grammar, the Lens, the device voice).
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$IOS/../.env"
OUT="$IOS/Config/Secrets.plist"
mkdir -p "$IOS/Config"
KEYS="ANTHROPIC_API_KEY CLAUDE_FAST_MODEL CLAUDE_MODEL CLAUDE_EFFORT CARTESIA_API_KEY CARTESIA_VOICE_ID CARTESIA_MODEL ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID ELEVENLABS_TTS_MODEL TTS_PROVIDER STT_PROVIDER"
xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
TMP="$OUT.tmp"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  if [ -f "$ENV_FILE" ]; then
    for k in $KEYS; do
      # Last assignment wins, like dotenv; strip surrounding quotes and whitespace.
      v="$(grep -E "^[[:space:]]*$k=" "$ENV_FILE" | tail -n1 | sed -E "s/^[[:space:]]*$k=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true)"
      [ -n "$v" ] && printf '  <key>%s</key><string>%s</string>\n' "$k" "$(printf '%s' "$v" | xml_escape)"
    done
  fi
  echo '</dict></plist>'
} > "$TMP"
# Only touch the file when it changed, so Xcode doesn't re-copy resources every build.
if ! cmp -s "$TMP" "$OUT" 2>/dev/null; then mv "$TMP" "$OUT"; else rm -f "$TMP"; fi
plutil -lint "$OUT" >/dev/null
echo "wrote $OUT ($(grep -c '<key>' "$OUT" || true) keys)"
