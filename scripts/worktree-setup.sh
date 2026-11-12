#!/usr/bin/env bash
#
# worktree-setup.sh — Make an existing git worktree ready to build, test and run.
#
# Usage:
#   scripts/worktree-setup.sh [worktree-dir]     # default: the checkout you are in
#   npm run setup:worktree                       # same, from the worktree root
#
# Worktrees made by Claude (the desktop app's session worktrees, `claude -w`)
# start with no node_modules and no ignored local config. This script:
#   1. copies `.env` and `packages/functions/local.settings.json` from the
#      primary checkout (or SOURCE_ROOT) when the worktree has none, falling
#      back to `.env.example` / `local.settings.json.example`;
#   2. runs `npm ci` when node_modules is missing (pass --reinstall to force it);
#   3. builds the shared types.
#
# It is idempotent and never overwrites a file the worktree already has.
#
set -euo pipefail

REINSTALL=false
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --reinstall) REINSTALL=true ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done

TARGET_ROOT="$(git -C "${TARGET:-.}" rev-parse --show-toplevel)"
PRIMARY_ROOT="$(git -C "$TARGET_ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
SOURCE_ROOT="${SOURCE_ROOT:-$PRIMARY_ROOT}"

echo "Setting up $TARGET_ROOT"

# copy_config <relative path> <example relative path> <placeholder hint>
copy_config() {
  local rel="$1" example_rel="$2" hint="$3"
  local target="$TARGET_ROOT/$rel"
  if [ -f "$target" ]; then
    echo "  $rel: already present, kept"
    return
  fi
  local source=""
  for root in "$SOURCE_ROOT" "$PRIMARY_ROOT"; do
    if [ -n "$root" ] && [ "$root" != "$TARGET_ROOT" ] && [ -f "$root/$rel" ]; then
      source="$root/$rel"
      break
    fi
  done
  mkdir -p "$(dirname "$target")"
  if [ -n "$source" ]; then
    cp "$source" "$target"
    echo "  $rel: copied from $source"
  elif [ -f "$TARGET_ROOT/$example_rel" ]; then
    cp "$TARGET_ROOT/$example_rel" "$target"
    echo "  $rel: created from $example_rel${hint:+ ($hint)}"
  else
    echo "  ⚠ $rel: no source or example found, create it by hand"
  fi
}

copy_config ".env" ".env.example" ""
copy_config "packages/functions/local.settings.json" \
  "packages/functions/local.settings.json.example" \
  "fill in the <YOUR_*> placeholders before starting the Functions host"

if [ "$REINSTALL" = true ] || [ ! -d "$TARGET_ROOT/node_modules" ]; then
  echo "Installing dependencies (npm ci)..."
  (cd "$TARGET_ROOT" && npm ci)
else
  echo "node_modules present, skipping npm ci (use --reinstall to force)"
fi

echo "Building shared types..."
(cd "$TARGET_ROOT" && npm run build:shared)

echo ""
echo "Worktree ready: $TARGET_ROOT"
