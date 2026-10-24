#!/usr/bin/env bash
# Packages and installs the Callbacks Bridge extension into VS Code (or Cursor).
set -euo pipefail
cd "$(dirname "$0")/../integrations/vscode-bridge"
npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o callbacks-bridge.vsix
CODE_BIN="$(command -v code || true)"
[ -z "$CODE_BIN" ] && CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE_BIN" --install-extension callbacks-bridge.vsix --force
if [ -x "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ]; then
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" --install-extension callbacks-bridge.vsix --force || true
fi
echo "Installed. Reload VS Code windows (Cmd+Shift+P → Developer: Reload Window)."
