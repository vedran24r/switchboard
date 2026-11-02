#!/bin/sh
# Keep the Switchboard map running (starts at login, restarts if it dies).
# Undo: launchctl bootout gui/$(id -u)/ai.switchboard.map && rm ~/Library/LaunchAgents/ai.switchboard.map.plist
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/ai.switchboard.map.plist"
mkdir -p "$HOME/.switchboard" "$(dirname "$PLIST")"   # LaunchAgents is missing on a fresh Mac
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.switchboard.map</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--disable-warning=ExperimentalWarning</string><string>$DIR/src/cli.ts</string><string>map</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.switchboard/map.log</string>
  <key>StandardErrorPath</key><string>$HOME/.switchboard/map.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/ai.switchboard.map" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Switchboard map: http://127.0.0.1:8790 (log: ~/.switchboard/map.log)"
