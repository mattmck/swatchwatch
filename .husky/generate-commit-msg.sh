#!/usr/bin/env sh

# AI commit message generator with provider fallback
# Tries: Claude CLI → Anthropic API → OpenAI API → manual

COMMIT_MSG_FILE=$1
DIFF_OUTPUT=$(git diff --cached --stat)

if [ -z "$DIFF_OUTPUT" ]; then
  echo "# No staged changes to analyze" >> "$COMMIT_MSG_FILE"
  exit 0
fi

# Get detailed diff for AI context
FULL_DIFF=$(git diff --cached)

# Shared prompt for all AI providers
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

# --- Provider detection ---

detect_provider() {
  if command -v claude >/dev/null 2>&1; then
    echo "claude-cli"
  elif [ -n "$ANTHROPIC_API_KEY" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    echo "anthropic-api"
  elif [ -n "$OPENAI_API_KEY" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    echo "openai-api"
  else
    echo "manual"
  fi
}

# --- Provider implementations ---

try_claude_cli() {
  claude -p --model haiku --max-turns 1 "$PROMPT" 2>/dev/null
}

try_anthropic_api() {
  curl -s https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"claude-3-5-haiku-20241022\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":$(printf '%s' "$PROMPT" | jq -Rs .)}]}" \
    | jq -r '.content[0].text' 2>/dev/null
}

try_openai_api() {
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "content-type: application/json" \
    -d "{\"model\":\"gpt-4o-mini\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":$(printf '%s' "$PROMPT" | jq -Rs .)}]}" \
    | jq -r '.choices[0].message.content' 2>/dev/null
}

write_manual_msg() {
  cat > "$COMMIT_MSG_FILE" << 'EOF'
# No AI provider available — write your commit message above.
#
# To enable AI suggestions, set up one of:
#   1. Claude Code CLI: install from https://docs.anthropic.com/en/docs/claude-code
#   2. Anthropic API key: export ANTHROPIC_API_KEY="sk-..."
#   3. OpenAI API key: export OPENAI_API_KEY="sk-..."
#
# Format: <type>: <subject>
# Types: feat, fix, refactor, docs, chore, test, style, perf
#
# Write your commit message above (delete all # comment lines)
EOF
}

# --- Main flow ---

# try_provider runs a provider function and sets SUGGESTIONS on success.
# Returns 0 if the provider produced usable output, 1 otherwise.
try_provider() {
  SUGGESTIONS=$("$@")
  if [ $? -ne 0 ] || [ -z "$SUGGESTIONS" ]; then
    SUGGESTIONS=""
    return 1
  fi
  # Filter out "null" responses from jq (API errors)
  case "$SUGGESTIONS" in
    null|"null") SUGGESTIONS=""; return 1 ;;
  esac
  return 0
}

PROVIDER=$(detect_provider)
SUGGESTIONS=""

# Try detected provider, then fall through to next on failure
case "$PROVIDER" in
  claude-cli)
    try_provider try_claude_cli || {
      PROVIDER="anthropic-api"
      if [ -n "$ANTHROPIC_API_KEY" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        try_provider try_anthropic_api
      fi
    }
    if [ -z "$SUGGESTIONS" ]; then
      PROVIDER="openai-api"
      if [ -n "$OPENAI_API_KEY" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        try_provider try_openai_api
      fi
    fi
    ;;
  anthropic-api)
    try_provider try_anthropic_api || {
      PROVIDER="openai-api"
      if [ -n "$OPENAI_API_KEY" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        try_provider try_openai_api
      fi
    }
    ;;
  openai-api)
    try_provider try_openai_api
    ;;
esac

if [ -n "$SUGGESTIONS" ]; then
  cat > "$COMMIT_MSG_FILE" << EOF
# AI-generated commit vibes ($PROVIDER):
#
EOF

  echo "$SUGGESTIONS" | while IFS= read -r line; do
    # Drop blank lines
    if [ -z "$line" ]; then
      continue
    fi

    # Strip common bullet/number prefixes if the model ignored instructions
    cleaned=$(echo "$line" | sed -E 's/^[[:space:]]*[-*][[:space:]]+//; s/^[[:space:]]*[0-9]+[.)][[:space:]]+//')

    echo "# - $cleaned" >> "$COMMIT_MSG_FILE"
  done

  cat >> "$COMMIT_MSG_FILE" << 'EOF'
#
# Pick one, customize it, or write your own.
#
# Format: <type>: <subject>
# Types: feat, fix, refactor, docs, chore, test, style, perf
#
# Write your commit message above (delete all # comment lines)
EOF
else
  write_manual_msg
fi
