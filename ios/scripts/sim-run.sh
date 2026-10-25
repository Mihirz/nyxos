#!/bin/bash
# Relaunch the installed app in the booted simulator with its console going to a log file.
# Usage: scripts/sim-run.sh LOGFILE [launch args...]   e.g. -NYX_MUTE YES -NYX_SCRIPT "o example.com"
LOG="$1"; shift
SIM="${NYX_SIM:-iPhone 18 Pro}"
xcrun simctl terminate "$SIM" com.nyxos.ios >/dev/null 2>&1 || true
nohup xcrun simctl launch --console-pty "$SIM" com.nyxos.ios "$@" > "$LOG" 2>&1 < /dev/null &
disown
echo "launched (log: $LOG)"
