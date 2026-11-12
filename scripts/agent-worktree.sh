#!/usr/bin/env bash
#
# agent-worktree.sh — Create or enter a git worktree for isolated agent work.
#
# Usage:
#   scripts/agent-worktree.sh <branch-name> [base-branch]
#
# Examples:
#   scripts/agent-worktree.sh feat/42-new-feature        # branch from dev
#   scripts/agent-worktree.sh fix/99-hotfix main          # branch from main
#
# Prefer Claude's own worktrees (the desktop app's session worktree, or
# `claude -w <name>` in a terminal) plus `npm run setup:worktree`: the app
# tracks and cleans those up. This script is for a hand-made worktree at
# ../<repo>-worktrees/<branch-name>; it then runs scripts/worktree-setup.sh.
#
# To clean up:
#   git worktree remove ../<repo>-worktrees/<branch-name>
#   git config core.bare false   # workaround: git may flip this on removal
#
set -euo pipefail

BRANCH="${1:?Usage: agent-worktree.sh <branch-name> [base-branch]}"
BASE="${2:-dev}"

CURRENT_ROOT="$(git rev-parse --show-toplevel)"
PRIMARY_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [ -z "${PRIMARY_ROOT:-}" ]; then
  PRIMARY_ROOT="$CURRENT_ROOT"
fi

REPO_NAME="$(basename "$PRIMARY_ROOT")"
WORKTREE_DIR="$(dirname "$PRIMARY_ROOT")/${REPO_NAME}-worktrees/${BRANCH}"

if [ -d "$WORKTREE_DIR" ]; then
  echo "Worktree already exists at $WORKTREE_DIR"
  echo "cd $WORKTREE_DIR"
  exit 0
fi

echo "Creating worktree for $BRANCH (based on $BASE)..."

# Create branch if it doesn't exist
if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git branch "$BRANCH" "$BASE"
fi

git worktree add "$WORKTREE_DIR" "$BRANCH"

# Copy local config, install deps and build shared types (same steps as
# `npm run setup:worktree` inside a worktree Claude made).
SOURCE_ROOT="$CURRENT_ROOT" bash "$(dirname "${BASH_SOURCE[0]}")/worktree-setup.sh" "$WORKTREE_DIR"

echo ""
echo "Worktree ready at: $WORKTREE_DIR"
echo "  cd $WORKTREE_DIR"
