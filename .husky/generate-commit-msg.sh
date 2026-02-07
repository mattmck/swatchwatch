#!/usr/bin/env sh

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
  # Fallback suggestions based on file patterns
  if echo "$DIFF_OUTPUT" | grep -q "package.json"; then
    echo "# - chore: ✨ fresh coat on dependency vibes" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.tsx\|\.ts"; then
    echo "# - feat: 💅 gloss up components for a smoother UI" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "test"; then
    echo "# - test: 🧪 nail down edge cases with extra coverage" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.md\|README"; then
    echo "# - docs: ✨ polish up the docs for a mirror shine" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.css\|\.scss\|tailwind"; then
    echo "# - style: ✨ add shimmer to the UI finish" >> "$COMMIT_MSG_FILE"
  fi
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
