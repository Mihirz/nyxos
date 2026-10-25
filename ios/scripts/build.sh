#!/bin/bash
# Generate secrets + bundle the shared core, generate the Xcode project, build for the simulator.
# Usage: scripts/build.sh            (build only)
#        scripts/build.sh run        (build, boot a simulator, install and launch)
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
cd "$IOS"
# A conda/toolchain environment (CC, LD, SDKROOT, ...) breaks Xcode's link step: drop it.
unset LD CC CXX AR NM RANLIB STRIP LDFLAGS CFLAGS CPPFLAGS CXXFLAGS SDKROOT CONDA_PREFIX 2>/dev/null || true
SIM="${NYX_SIM:-iPhone 18 Pro}"
"$IOS/scripts/gen-secrets.sh"
"$IOS/scripts/bundle-core.sh"
/opt/homebrew/bin/xcodegen generate --spec project.yml --quiet
xcodebuild -project nyxOS.xcodeproj -scheme nyxOS -configuration Debug \
  -destination "platform=iOS Simulator,name=$SIM" -derivedDataPath "$IOS/build" \
  CODE_SIGNING_ALLOWED=NO build -quiet
APP="$IOS/build/Build/Products/Debug-iphonesimulator/nyxOS.app"
echo "built $APP"
if [ "${1:-}" = "run" ]; then
  xcrun simctl boot "$SIM" 2>/dev/null || true
  open -a Simulator || true
  xcrun simctl install "$SIM" "$APP"
  shift
  xcrun simctl launch "$SIM" com.nyxos.ios "$@"
fi
