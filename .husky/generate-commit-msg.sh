#!/usr/bin/env sh

# Ensure git commands inspect the repo at the current working directory.
unset GIT_DIR
unset GIT_WORK_TREE
unset GIT_INDEX_FILE

# Vibey commit message generator
# Uses Anthropic Claude to generate commit suggestions based on staged changes

COMMIT_MSG_FILE=$1
DIFF_OUTPUT=$(git diff --cached --stat)

if [ -z "$DIFF_OUTPUT" ]; then
  echo "# No staged changes to analyze" >> "$COMMIT_MSG_FILE"
  exit 0
fi

# Get detailed diff for AI context
FULL_DIFF=$(git diff --cached)

# Prepare prompt for AI
PROMPT="You're writing commit message suggestions for SwatchWatch.

Generate 3 vibey Conventional Commit suggestions inspired by the staged changes.

Vibe rules:
- Format: <type>: <subject>
- Types: feat, fix, refactor, docs, chore, test, style
- Keep it nail-polish-adjacent (colors, finishes, manicure verbs, collection vibes)
- Keep the subject under 72 characters
- Reference the actual change
- Emojis are optional. Never put emoji before the type.
- If you include an emoji, it must be in the subject (after <type>: )
- Provide 3 suggestions: at least 1 with no emoji, at least 1 with an emoji

Staged changes:
$DIFF_OUTPUT

Diff preview (first 500 lines):
$(echo "$FULL_DIFF" | head -n 500)

Generate exactly 3 suggestions, one per line, no explanations or numbering."

# Try to use Claude API if available
if command -v claude 2>/dev/null && [ -n "$ANTHROPIC_API_KEY" ]; then
  SUGGESTIONS=$(echo "$PROMPT" | claude --model claude-3-5-sonnet-20241022 --max-tokens 200 2>/dev/null)
elif [ -n "$ANTHROPIC_API_KEY" ] && command -v jq 2>/dev/null; then
  # Use curl if claude CLI not available (requires jq)
  SUGGESTIONS=$(curl -s https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"claude-3-5-sonnet-20241022\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":$(echo "$PROMPT" | jq -Rs .)}]}" \
    | jq -r '.content[0].text' 2>/dev/null)
fi

# Write suggestions to commit message file
cat > "$COMMIT_MSG_FILE" << EOF
# AI-generated commit vibes:
#
EOF

if [ -n "$SUGGESTIONS" ]; then
  echo "$SUGGESTIONS" | while IFS= read -r line; do
    # Drop blank lines
    if [ -z "$line" ]; then
      continue
    fi

    # Strip common bullet/number prefixes if the model ignored instructions
    cleaned=$(echo "$line" | sed -E 's/^[[:space:]]*[-*][[:space:]]+//; s/^[[:space:]]*[0-9]+[.)][[:space:]]+//')

    # Remove our own marker emoji if the model included it
    cleaned=$(echo "$cleaned" | sed 's/💡//g')

    echo "# - $cleaned" >> "$COMMIT_MSG_FILE"
  done
else
  # Smarter fallback: extract what actually changed
  # Get list of changed files (without stats)
  CHANGED_FILES=$(git diff --cached --name-only)

  # Extract key details from the diff
  ADDED_FUNCS=$(echo "$FULL_DIFF" | grep -E '^\+.*(function|const|export)' | head -3 | sed 's/^+//' | tr '\n' ' ')
  REMOVED_FUNCS=$(echo "$FULL_DIFF" | grep -E '^-.*(function|const|export)' | head -3 | sed 's/^-//' | tr '\n' ' ')

  # Detect primary change type from paths
  PRIMARY_PATH=$(echo "$CHANGED_FILES" | head -1)

  # Generate context-aware suggestions
  if echo "$CHANGED_FILES" | grep -q "commitlint\|husky"; then
    echo "# - chore: buff the commit hooks for smoother vibes" >> "$COMMIT_MSG_FILE"
    echo "# - chore: 💅 refine git workflow polish" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "components/"; then
    COMP_NAME=$(echo "$CHANGED_FILES" | grep "components/" | head -1 | sed 's/.*components\///; s/\.tsx//; s/\.ts//; s/\// /g' | awk '{print $NF}')
    echo "# - feat: add shimmer to ${COMP_NAME:-components}" >> "$COMMIT_MSG_FILE"
    echo "# - refactor: 💅 buff ${COMP_NAME:-components} for a smoother finish" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "app/.*page"; then
    PAGE_NAME=$(echo "$CHANGED_FILES" | grep "page" | head -1 | sed 's/.*app\///; s/\/page\.tsx//; s/\// /g')
    echo "# - feat: gloss up the ${PAGE_NAME:-page} view" >> "$COMMIT_MSG_FILE"
    echo "# - feat: ✨ fresh coat on ${PAGE_NAME:-page}" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "functions/"; then
    FUNC_NAME=$(echo "$CHANGED_FILES" | grep "functions/" | head -1 | sed 's/.*functions\///; s/\.ts//')
    echo "# - feat: polish the ${FUNC_NAME:-API} endpoint" >> "$COMMIT_MSG_FILE"
    echo "# - fix: 🔧 cure ${FUNC_NAME:-API} edge cases" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "infrastructure/\|\.tf"; then
    echo "# - chore: lacquer the infrastructure config" >> "$COMMIT_MSG_FILE"
    echo "# - chore: 🏗️ buff terraform for a cleaner deploy" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "test"; then
    echo "# - test: 🧪 nail down edge cases" >> "$COMMIT_MSG_FILE"
    echo "# - test: add coverage for a chip-free finish" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "\.md\|README"; then
    echo "# - docs: polish up the readme shine" >> "$COMMIT_MSG_FILE"
    echo "# - docs: ✨ glossy new documentation" >> "$COMMIT_MSG_FILE"
  elif echo "$CHANGED_FILES" | grep -q "package.json"; then
    echo "# - chore: fresh coat on dependencies" >> "$COMMIT_MSG_FILE"
    echo "# - chore: ✨ update the dependency palette" >> "$COMMIT_MSG_FILE"
  else
    # Generic but still try to be specific
    FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
    echo "# - feat: buff ${FILE_COUNT} files for a smoother finish" >> "$COMMIT_MSG_FILE"
    echo "# - refactor: 💅 polish codebase details" >> "$COMMIT_MSG_FILE"
  fi

  # Always add one that mentions the actual primary file
  MAIN_FILE=$(basename "$PRIMARY_PATH" | sed 's/\.[^.]*$//')
  echo "# - feat: ✨ update ${MAIN_FILE} with fresh shine" >> "$COMMIT_MSG_FILE"
fi

cat >> "$COMMIT_MSG_FILE" << 'EOF'
#
# Pick one, customize it, or write your own.
#
# Vibe words (optional):
#   Colors/finishes: shimmer, chrome, glossy, matte, holographic
#   Manicure verbs: buff, file, coat, cure, polish, swatch
#   Collection vibes: stash, catalog, inventory, dupe
#
# Format: <type>: <subject>
# Emoji (optional): if you use one, put it in the subject (after <type>: ), e.g.
#   feat: ✨ add shimmer finish to swatch cards
#
# Types: feat, fix, refactor, docs, chore, test, style, perf
#
# Write your commit message above (delete all # comment lines)
EOF
