#!/bin/zsh
# Install (or remove) a launchd agent so the bridge starts at login and is
# restarted if it crashes.
#
#   scripts/install-service.sh            install + start
#   scripts/install-service.sh --remove   unload + delete
#   scripts/install-service.sh --status   show state
set -e
LABEL="ai.opencode-commandcode-go.bridge"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
PORT_TO_FREE="${CMD_BRIDGE_PORT:-8787}"

if [ "$1" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

if [ "$1" = "--status" ]; then
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | head -8 || echo "not loaded"
  exit 0
fi

[ -x "$NODE" ] || { echo "node not found on PATH"; exit 1 }
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" "$REPO/scripts/launchd.plist.template" > "$PLIST"

# Take ownership from any manually-started bridge. Match on the absolute bridge
# path, which is what both this script and launchd spawn, so a relative-path
# invocation still matches.
for pid in $(lsof -ti:"$PORT_TO_FREE" 2>/dev/null); do
  if ps -p "$pid" -o command= 2>/dev/null | grep -q "src/bridge.js"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done
pkill -f "src/bridge.js" 2>/dev/null || true
sleep 1

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 2
echo "installed and started $LABEL"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid" | head -3
