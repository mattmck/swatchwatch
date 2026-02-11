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
# without touching the primary checkout. Copies local ignored config files
# when present, installs deps, and builds shared types.
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

copy_if_present() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"

  if [ -f "$source_path" ] && [ ! -f "$target_path" ]; then
    mkdir -p "$(dirname "$target_path")"
    cp "$source_path" "$target_path"
    echo "Copied $label into new worktree."
  fi
}

first_existing_path() {
  local current_candidate="$1"
  local primary_candidate="$2"
  if [ -f "$current_candidate" ]; then
    printf "%s" "$current_candidate"
  elif [ -f "$primary_candidate" ]; then
    printf "%s" "$primary_candidate"
  fi
}

# Bring over local ignored dev settings from the source checkout.
SOURCE_ENV="$(first_existing_path "$CURRENT_ROOT/.env" "$PRIMARY_ROOT/.env")"
SOURCE_LOCAL_SETTINGS="$(first_existing_path "$CURRENT_ROOT/packages/functions/local.settings.json" "$PRIMARY_ROOT/packages/functions/local.settings.json")"

if [ -n "${SOURCE_ENV:-}" ]; then
  copy_if_present "$SOURCE_ENV" "$WORKTREE_DIR/.env" ".env"
elif [ ! -f "$WORKTREE_DIR/.env" ] && [ -f "$WORKTREE_DIR/.env.example" ]; then
  cp "$WORKTREE_DIR/.env.example" "$WORKTREE_DIR/.env"
  echo "Created .env from .env.example (no existing .env found to copy)."
fi

if [ -n "${SOURCE_LOCAL_SETTINGS:-}" ]; then
  copy_if_present "$SOURCE_LOCAL_SETTINGS" "$WORKTREE_DIR/packages/functions/local.settings.json" "packages/functions/local.settings.json"
elif [ ! -f "$WORKTREE_DIR/packages/functions/local.settings.json" ]; then
  mkdir -p "$WORKTREE_DIR/packages/functions"
  cat > "$WORKTREE_DIR/packages/functions/local.settings.json" <<'SETTINGS'
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;",
    "AZURE_STORAGE_CONNECTION": "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;",
    "SOURCE_IMAGE_CONTAINER": "source-images",
    "PGHOST": "localhost",
    "PGPORT": "55432",
    "PGDATABASE": "swatchwatch",
    "PGUSER": "postgres",
    "PGPASSWORD": "swatchwatch_dev",
    "AUTH_DEV_BYPASS": "true"
  }
}
SETTINGS
  echo "Created packages/functions/local.settings.json with dev defaults (no existing file found to copy)."
fi

echo "Installing dependencies..."
(cd "$WORKTREE_DIR" && npm ci)

echo "Building shared types..."
(cd "$WORKTREE_DIR" && npm run build --workspace=packages/shared)

echo ""
echo "Worktree ready at: $WORKTREE_DIR"
echo "  cd $WORKTREE_DIR"
