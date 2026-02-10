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
# Creates a worktree at ../<repo>-worktrees/<branch-name> so agents can work
# without touching the primary checkout. Installs deps and builds shared types.
#
# To clean up:
#   git worktree remove ../<repo>-worktrees/<branch-name>
#   git config core.bare false   # workaround: git may flip this on removal
#
set -euo pipefail

BRANCH="${1:?Usage: agent-worktree.sh <branch-name> [base-branch]}"
BASE="${2:-dev}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/${REPO_NAME}-worktrees/${BRANCH}"

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

echo "Installing dependencies..."
(cd "$WORKTREE_DIR" && npm ci)

echo "Building shared types..."
(cd "$WORKTREE_DIR" && npm run build --workspace=packages/shared)

echo ""
echo "Worktree ready at: $WORKTREE_DIR"
echo "  cd $WORKTREE_DIR"
