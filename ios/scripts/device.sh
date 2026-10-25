#!/bin/bash
# Build, install and run scripted sessions on a real iPhone (muted).
#
#   scripts/device.sh build                      secrets + core bundle + xcodegen + device build
#   scripts/device.sh install                    install the last device build
#   scripts/device.sh run "o amazon;s tacos" [timeout-seconds] [extra launch args]
#                                                launch muted with NYX_SCRIPT, print the transcript,
#                                                stop at "[script] done" (or the timeout), then kill
#                                                the console process
#   scripts/device.sh all "o amazon;s tacos"     build, install, run
#
# Settings: NYX_DEVICE (UDID), NYX_TEAM (signing team), NYX_LOG (transcript file).
# The phone must be unlocked. Free personal teams need the app trusted once on the phone.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
cd "$IOS"
# A conda/toolchain environment (CC, LD, SDKROOT, ...) breaks Xcode's link step: drop it.
unset LD CC CXX AR NM RANLIB STRIP LDFLAGS CFLAGS CPPFLAGS CXXFLAGS SDKROOT CONDA_PREFIX 2>/dev/null || true
DEVICE="${NYX_DEVICE:-00008140-000202183A22801C}"
TEAM="${NYX_TEAM:-HR7GGACVZV}"
LOG="${NYX_LOG:-$IOS/build-device/session.log}"
APP="$IOS/build-device/Build/Products/Debug-iphoneos/nyxOS.app"

build() {
  "$IOS/scripts/gen-secrets.sh"
  "$IOS/scripts/bundle-core.sh"
  /opt/homebrew/bin/xcodegen generate --spec project.yml --quiet
  xcodebuild -project nyxOS.xcodeproj -scheme nyxOS -configuration Debug -destination "id=$DEVICE" \
    -derivedDataPath "$IOS/build-device" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY="Apple Development" build -quiet
  echo "built $APP"
}

install() { xcrun devicectl device install app --device "$DEVICE" "$APP" | tail -3; }

run() {
  local script="$1"; shift
  local timeout="${1:-180}"; [ $# -gt 0 ] && shift
  mkdir -p "$(dirname "$LOG")"
  : > "$LOG"
  xcrun devicectl device process launch --device "$DEVICE" --console --terminate-existing com.nyxos.ios \
    -NYX_MUTE YES -NYX_SCRIPT "$script" "$@" > "$LOG" 2>&1 &
  local pid=$!
  local waited=0
  while ! grep -q '\[script\] done' "$LOG" 2>/dev/null; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$waited" -ge "$timeout" ]; then break; fi
    sleep 2; waited=$((waited + 2))
  done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  grep -E '^\[(user|nyx|system|script|eval|tap|glance|claude|timing|lens|feed|camera)|^> ' "$LOG" || cat "$LOG"
  if grep -q 'device was not, or could not be, unlocked' "$LOG"; then echo "(the iPhone is locked: unlock it and run again)"; return 1; fi
  grep -q '\[script\] done' "$LOG" || echo "(timed out after ${timeout}s; full log: $LOG)"
}

case "${1:-}" in
  build) build ;;
  install) install ;;
  run) shift; run "$@" ;;
  all) shift; build; install; run "$@" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
