#!/bin/bash
# Smoke test in the simulator: install the last build and run typed commands (muted), print the
# transcript, and stop at "[script] done" (or the timeout). NYX_SHOT=screenshots/x.png saves a
# screenshot at the end.
# Usage: NYX_LOG=/tmp/nyx.log scripts/sim-test.sh "o example.com;a" [timeout-seconds] [extra launch args]
set -e
IOS="$(cd "$(dirname "$0")/.." && pwd)"
SIM="${NYX_SIM:-iPhone 18 Pro}"
LOG="${NYX_LOG:-$IOS/build/sim-session.log}"
xcrun simctl install "$SIM" "$IOS/build/Build/Products/Debug-iphonesimulator/nyxOS.app"
SCRIPT="$1"; shift
TIMEOUT="${1:-180}"; [ $# -gt 0 ] && shift
xcrun simctl terminate "$SIM" com.nyxos.ios >/dev/null 2>&1 || true
: > "$LOG"
xcrun simctl launch --console-pty "$SIM" com.nyxos.ios -NYX_MUTE YES -NYX_SCRIPT "$SCRIPT" "$@" > "$LOG" 2>&1 < /dev/null &
PID=$!
WAITED=0
while ! grep -q '\[script\] done' "$LOG" 2>/dev/null; do
  if ! kill -0 "$PID" 2>/dev/null || [ "$WAITED" -ge "$TIMEOUT" ]; then break; fi
  sleep 2; WAITED=$((WAITED + 2))
done
sleep 1
# NYX_SHOT=path takes a screenshot before the console is detached.
[ -n "${NYX_SHOT:-}" ] && xcrun simctl io "$SIM" screenshot "$NYX_SHOT" >/dev/null 2>&1 && echo "screenshot: $NYX_SHOT"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
grep -E '^\[(user|nyx|system|script|eval|tap|glance|claude|timing|lens|feed|camera)|^> ' "$LOG" || cat "$LOG"
grep -q '\[script\] done' "$LOG" || echo "(timed out after ${TIMEOUT}s; full log: $LOG)"
