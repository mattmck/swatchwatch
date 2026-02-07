#!/usr/bin/env sh

# AI-powered nail polish themed commit message generator
# Uses Anthropic Claude to generate vibe-y commit suggestions

COMMIT_MSG_FILE=$1
DIFF_OUTPUT=$(git diff --cached --stat)

if [ -z "$DIFF_OUTPUT" ]; then
  echo "# No staged changes to analyze" >> "$COMMIT_MSG_FILE"
  exit 0
fi

# Get detailed diff for AI context
FULL_DIFF=$(git diff --cached)

# Prepare prompt for AI
PROMPT="You are a commit message generator for SwatchWatch, a nail polish collection manager app.

Generate 3 commit message suggestions that follow Conventional Commits format but with NAIL POLISH themed language.

Requirements:
- Format: <type>: <subject with polish puns/terms>
- Types: feat, fix, refactor, docs, chore, test, style
- Must include nail polish terms: polish, swatch, coat, finish, shade, lacquer, shimmer, glossy, matte, chrome, holographic, buff, file, nail, painted, flawless, dupe, etc.
- Be creative with puns and metaphors
- Keep subject line under 72 characters
- Reference the actual changes being made
- Emoji: optional (do NOT put emoji before the type)
- If you include an emoji, it can be anywhere in the SUBJECT (after the `type: `), including right at the start of the subject
- Provide 3 suggestions total: at least 1 with no emoji, and at least 1 with a relevant emoji in the subject

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
# AI-generated nail polish commit suggestions:
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
    echo "# - chore: buff up dependency versions with a fresh coat" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.tsx\|\.ts"; then
    echo "# - feat: apply a new coat to component polish for a glossy UI 💅" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "test"; then
    echo "# - test: nail down edge cases with glossy coverage" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.md\|README"; then
    echo "# - docs: polish documentation to a mirror shine ✨" >> "$COMMIT_MSG_FILE"
  fi
  if echo "$DIFF_OUTPUT" | grep -q "\.css\|\.scss\|tailwind"; then
    echo "# - style: add shimmer effect to UI finish" >> "$COMMIT_MSG_FILE"
  fi
fi

cat >> "$COMMIT_MSG_FILE" << 'EOF'
#
# Pick one, customize it, or write your own.
#
# Nail polish vocabulary to use:
#   Colors: ruby, crimson, shimmer, chrome, holographic, pearl, matte
#   Terms: polish, swatch, coat, finish, shade, nail, lacquer, gloss
#   Puns: buff, file, nailed it, painted, flawless, chip, cure, top coat
#   Collection: brand, dupe, inventory, catalog, stash, bottle
#
# Format: <type>: <nail-polish-themed subject>
# Emoji (optional): if you use one, put it in the subject (after 'type: '), e.g.
#   feat: ✨ add shimmer finish to swatch cards
#
# Types: feat, fix, refactor, docs, chore, test, style, perf
#
# Write your commit message above (delete all # comment lines)
EOF
