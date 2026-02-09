#!/usr/bin/env bash
# Unit tests for detect-changes.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/detect-changes.sh"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  
  if [ "$expected" = "$actual" ]; then
    return 0
  else
    echo -e "${RED}FAIL${NC}: $message"
    echo "  Expected: $expected"
    echo "  Actual:   $actual"
    return 1
  fi
}

run_test() {
  local test_name="$1"
  local test_func="$2"
  
  TESTS_RUN=$((TESTS_RUN + 1))
  
  # Reset flags before each test
  BUILD_SHARED=false
  BUILD_WEB=false
  BUILD_FUNCTIONS=false
  VALIDATE_INFRA=false
  
  if $test_func; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}PASS${NC}: $test_name"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
}

# Test 1: Changes in packages/shared/ sets BUILD_SHARED=true and triggers dependent builds
test_shared_changes_trigger_dependents() {
  local changed_files="packages/shared/src/types/polish.ts
packages/shared/src/index.ts"
  
  detect_changes "$changed_files"
  
  assert_equals "true" "$BUILD_SHARED" "BUILD_SHARED should be true for packages/shared/ changes" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true when shared changes (dependent)" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true when shared changes (dependent)" || return 1
  assert_equals "false" "$VALIDATE_INFRA" "VALIDATE_INFRA should be false for shared changes" || return 1
}

# Test 2: Changes in apps/web/ sets BUILD_WEB=true
test_web_changes() {
  local changed_files="apps/web/src/app/page.tsx
apps/web/src/components/ui/button.tsx"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for web-only changes" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true for apps/web/ changes" || return 1
  assert_equals "false" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be false for web-only changes" || return 1
  assert_equals "false" "$VALIDATE_INFRA" "VALIDATE_INFRA should be false for web-only changes" || return 1
}

# Test 3: Changes in packages/functions/ sets BUILD_FUNCTIONS=true
test_functions_changes() {
  local changed_files="packages/functions/src/functions/polishes.ts
packages/functions/src/lib/db.ts"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for functions-only changes" || return 1
  assert_equals "false" "$BUILD_WEB" "BUILD_WEB should be false for functions-only changes" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true for packages/functions/ changes" || return 1
  assert_equals "false" "$VALIDATE_INFRA" "VALIDATE_INFRA should be false for functions-only changes" || return 1
}

# Test 4: Changes in infrastructure/ sets VALIDATE_INFRA=true
test_infrastructure_changes() {
  local changed_files="infrastructure/main.tf
infrastructure/variables.tf"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for infra-only changes" || return 1
  assert_equals "false" "$BUILD_WEB" "BUILD_WEB should be false for infra-only changes" || return 1
  assert_equals "false" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be false for infra-only changes" || return 1
  assert_equals "true" "$VALIDATE_INFRA" "VALIDATE_INFRA should be true for infrastructure/ changes" || return 1
}

# Test 5: Changes in packages/shared/package.json triggers builds for shared, web, and functions
test_shared_package_json_triggers_all_dependents() {
  local changed_files="packages/shared/package.json"
  
  detect_changes "$changed_files"
  
  assert_equals "true" "$BUILD_SHARED" "BUILD_SHARED should be true for shared package.json change" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true for shared package.json change" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true for shared package.json change" || return 1
  assert_equals "false" "$VALIDATE_INFRA" "VALIDATE_INFRA should be false for shared package.json change" || return 1
}

# Additional edge case tests

# Test 6: Root package.json triggers all builds
test_root_package_json_triggers_all() {
  local changed_files="package.json"
  
  detect_changes "$changed_files"
  
  assert_equals "true" "$BUILD_SHARED" "BUILD_SHARED should be true for root package.json change" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true for root package.json change" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true for root package.json change" || return 1
}

# Test 7: Web package.json only triggers web build
test_web_package_json() {
  local changed_files="apps/web/package.json"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for web package.json change" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true for web package.json change" || return 1
  assert_equals "false" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be false for web package.json change" || return 1
}

# Test 8: Functions package.json only triggers functions build
test_functions_package_json() {
  local changed_files="packages/functions/package.json"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for functions package.json change" || return 1
  assert_equals "false" "$BUILD_WEB" "BUILD_WEB should be false for functions package.json change" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true for functions package.json change" || return 1
}

# Test 9: Multiple workspaces changed
test_multiple_workspaces() {
  local changed_files="apps/web/src/app/page.tsx
packages/functions/src/functions/auth.ts
infrastructure/outputs.tf"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false when shared not changed" || return 1
  assert_equals "true" "$BUILD_WEB" "BUILD_WEB should be true for web changes" || return 1
  assert_equals "true" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be true for functions changes" || return 1
  assert_equals "true" "$VALIDATE_INFRA" "VALIDATE_INFRA should be true for infra changes" || return 1
}

# Test 10: No matching paths
test_no_matching_paths() {
  local changed_files="README.md
docs/implementation-guide.md
.gitignore"
  
  detect_changes "$changed_files"
  
  assert_equals "false" "$BUILD_SHARED" "BUILD_SHARED should be false for non-matching files" || return 1
  assert_equals "false" "$BUILD_WEB" "BUILD_WEB should be false for non-matching files" || return 1
  assert_equals "false" "$BUILD_FUNCTIONS" "BUILD_FUNCTIONS should be false for non-matching files" || return 1
  assert_equals "false" "$VALIDATE_INFRA" "VALIDATE_INFRA should be false for non-matching files" || return 1
}

# Run all tests
echo "Running detect-changes.sh unit tests..."
echo "========================================"

run_test "1. Shared changes trigger dependent builds" test_shared_changes_trigger_dependents
run_test "2. Web changes set BUILD_WEB=true" test_web_changes
run_test "3. Functions changes set BUILD_FUNCTIONS=true" test_functions_changes
run_test "4. Infrastructure changes set VALIDATE_INFRA=true" test_infrastructure_changes
run_test "5. Shared package.json triggers all dependent builds" test_shared_package_json_triggers_all_dependents
run_test "6. Root package.json triggers all builds" test_root_package_json_triggers_all
run_test "7. Web package.json only triggers web build" test_web_package_json
run_test "8. Functions package.json only triggers functions build" test_functions_package_json
run_test "9. Multiple workspaces changed" test_multiple_workspaces
run_test "10. No matching paths" test_no_matching_paths

echo "========================================"
echo "Results: $TESTS_PASSED/$TESTS_RUN passed"

if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "${RED}$TESTS_FAILED test(s) failed${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
