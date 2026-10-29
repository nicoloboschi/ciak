#!/usr/bin/env bash
# ciak installer. Safe to run again: it updates instead.
#   curl -fsSL https://raw.githubusercontent.com/nicoloboschi/ciak/main/install.sh | bash
# Clones ciak into ~/.ciak/app, then `ciak app install`: the menu bar app (⌘1 screenshot, ⌘2 record),
# the ciak command in ~/.local/bin, and the skill for Claude Code.
set -euo pipefail

REPO="${CIAK_REPO:-https://github.com/nicoloboschi/ciak.git}"
APP="${CIAK_HOME:-$HOME/.ciak/app}"
BIN="$HOME/.local/bin"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'ciak: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "needs macOS 15 or newer."
command -v git >/dev/null || fail "needs git: xcode-select --install"
command -v swiftc >/dev/null || fail "needs the Xcode command line tools: xcode-select --install"
command -v node >/dev/null || fail "needs Node.js 22 or newer: brew install node"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "needs Node.js 22 or newer (you have $(node -v))."
command -v ffmpeg >/dev/null || fail "needs ffmpeg: brew install ffmpeg"
[ -d "/Applications/Brave Browser.app" ] || fail "needs Brave (the browser your agent records itself in, with a copy of your logins): brew install --cask brave-browser"
command -v uv >/dev/null || echo "Optional: uv, for captions and narration in your own voice: brew install uv"

if [ -d "$APP/.git" ]; then
  say "Updating ciak in $APP"
  git -C "$APP" pull --ff-only --quiet
else
  say "Installing ciak in $APP"
  mkdir -p "$(dirname "$APP")"
  git clone --quiet --depth 1 "$REPO" "$APP"
fi

(cd "$APP" && npm install --omit=dev --no-audit --no-fund --silent)
say "Setting up the menu bar app"
"$APP/ciak" app install >/dev/null

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add $BIN to your PATH to use the ciak command." ;;
esac

say "Done. 🎬 is in your menu bar: ⌘1 takes a screenshot, ⌘2 records."
echo "macOS asks once for Screen Recording (and Microphone when you record): allow ciak."
echo "Then ask your agent: \"use ciak to record yourself doing …\". Update later with: ciak app update"
