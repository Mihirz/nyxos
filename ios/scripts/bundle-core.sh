#!/bin/bash
# Bundle the desktop's pure-TS core (src/core, Lens page scripts, URL helpers) into one JS file
# that the iOS app runs in JavaScriptCore. Writes only inside ios/.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$IOS/.." && pwd)"
ESBUILD="$ROOT/node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || ESBUILD="npx --no-install esbuild"
$ESBUILD "$IOS/js/core-entry.ts" --bundle --format=iife --global-name=NyxCore --target=es2020 \
  --alias:linkedom="$IOS/js/stub-linkedom.js" --alias:@mozilla/readability="$IOS/js/stub-readability.js" \
  --log-level=warning --outfile="$IOS/nyxOS/Resources/nyxcore.js"
echo "bundled $IOS/nyxOS/Resources/nyxcore.js"
# Prompts and tool definitions from src/main/claude.ts (needs node; the committed copy is used otherwise).
if command -v node >/dev/null; then node "$IOS/scripts/extract-prompts.mjs" || echo "warning: prompts.json not refreshed"; fi
