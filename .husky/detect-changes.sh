#!/usr/bin/env sh
# Change detection logic for pre-push hook
# This script is extracted for testability

# Detect which workspaces need building based on changed files
# Input: CHANGED_FILES environment variable (newline-separated list of files)
# Output: Sets BUILD_SHARED, BUILD_WEB, BUILD_FUNCTIONS, VALIDATE_INFRA to true/false

detect_changes() {
  local changed_files="$1"
  
  # Initialize flags
  BUILD_SHARED=false
  BUILD_WEB=false
  BUILD_FUNCTIONS=false
  VALIDATE_INFRA=false

  # Check for path-based changes
  if echo "$changed_files" | grep -q "^packages/shared/"; then
    BUILD_SHARED=true
  fi
  if echo "$changed_files" | grep -q "^apps/web/"; then
    BUILD_WEB=true
  fi
  if echo "$changed_files" | grep -q "^packages/functions/"; then
    BUILD_FUNCTIONS=true
  fi
  if echo "$changed_files" | grep -q "^infrastructure/"; then
    VALIDATE_INFRA=true
  fi

  # Check for dependency changes
  if echo "$changed_files" | grep -qE "(^|/)package\.json$|^package-lock\.json$"; then
    if echo "$changed_files" | grep -qE "^packages/shared/(package\.json|package-lock\.json)$"; then
      BUILD_SHARED=true
      BUILD_WEB=true
      BUILD_FUNCTIONS=true
    fi
    if echo "$changed_files" | grep -qE "^apps/web/(package\.json|package-lock\.json)$"; then
      BUILD_WEB=true
    fi
    if echo "$changed_files" | grep -qE "^packages/functions/(package\.json|package-lock\.json)$"; then
      BUILD_FUNCTIONS=true
    fi
    if echo "$changed_files" | grep -qE "^(package\.json|package-lock\.json)$"; then
      BUILD_SHARED=true
      BUILD_WEB=true
      BUILD_FUNCTIONS=true
    fi
  fi

  # If shared changed, dependent packages need rebuilding
  if [ "$BUILD_SHARED" = true ]; then
    BUILD_WEB=true
    BUILD_FUNCTIONS=true
  fi

  # Export results
  export BUILD_SHARED BUILD_WEB BUILD_FUNCTIONS VALIDATE_INFRA
}

# Only run if executed directly (not sourced)
if [ "${0##*/}" = "detect-changes.sh" ]; then
  if [ -n "$1" ]; then
    detect_changes "$1"
    echo "BUILD_SHARED=$BUILD_SHARED"
    echo "BUILD_WEB=$BUILD_WEB"
    echo "BUILD_FUNCTIONS=$BUILD_FUNCTIONS"
    echo "VALIDATE_INFRA=$VALIDATE_INFRA"
  fi
fi
