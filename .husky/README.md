# Husky Git Hooks

This directory contains git hooks for SwatchWatch that enforce code quality and provide vibey commit message suggestions.

## Hooks

- **pre-commit**: Runs `npm test` to ensure all tests pass before committing
- **commit-msg**: Validates commit messages follow Conventional Commits format via commitlint
- **prepare-commit-msg**: Generates vibey commit message suggestions based on staged changes

## AI-Powered Commit Messages

The `prepare-commit-msg` hook uses a provider fallback chain to generate commit suggestions from your staged diff.

### Provider Cascade

The hook tries each provider in order and uses the first one that works:

| Priority | Provider | Requirements |
|----------|----------|-------------|
| 1 | **Claude CLI** | `claude` binary in PATH (uses Claude Code's own auth — no API key needed) |
| 2 | **Anthropic API** | `ANTHROPIC_API_KEY` env var + `curl` + `jq` |
| 3 | **OpenAI API** | `OPENAI_API_KEY` env var + `curl` + `jq` |
| 4 | **Manual** | No requirements — prompts you to write your own message |

If a provider fails (empty output or error), the hook automatically tries the next one.

### Setup

**Option 1: Claude Code CLI (recommended)**

Install Claude Code from https://docs.anthropic.com/en/docs/claude-code — no API key needed, it uses its own auth.

**Option 2: Anthropic API key**

```bash
# Add to your ~/.zshrc or ~/.bashrc
export ANTHROPIC_API_KEY="your-api-key-here"
```

Get your API key from: https://console.anthropic.com/settings/keys

**Option 3: OpenAI API key**

```bash
# Add to your ~/.zshrc or ~/.bashrc
export OPENAI_API_KEY="your-api-key-here"
```

### How It Works

1. When you run `git commit`, the hook analyzes your staged changes
2. It detects the best available AI provider
3. The provider generates 3 creative commit message options
4. The suggestions appear as comments in your commit message editor
5. Pick one, customize it, or write your own!

### No AI Available

If no AI provider is available, the hook writes a comment block telling you to write your own message — no auto-generated stub suggestions.

### Example Output

```
# AI-generated commit vibes (claude-cli):
#
# - feat: ✨ add shimmer finish to swatch cards
# - fix: polish swatch rendering edge cases
# - docs: add glossy API notes 💅
#
# Pick one, customize it, or write your own.
#
# Format: <type>: <subject>
# Types: feat, fix, refactor, docs, chore, test, style, perf
#
# Write your commit message above (delete all # comment lines)
```

### Emoji guideline
Emojis are optional.
Emojis are allowed anywhere in the subject, as long as they appear after `type: `.
Examples:
- `feat: ✨ add shimmer finish to swatch cards`
- `feat: add shimmer finish to swatch cards ✨`
Don't put an emoji before the type.


## Vibe Words
When writing commit messages, sprinkle in nail-polish-adjacent words:

**Finishes/colors**: shimmer, chrome, glossy, matte, holographic
**Manicure verbs**: buff, file, coat, cure, polish, swatch
**Collection vibes**: stash, catalog, inventory, dupe

## Conventional Commits

All commits must follow the format: `<type>: <subject>`

**Types**: feat, fix, refactor, docs, chore, test, style, perf, ci, build

**Examples**:
- `feat: add holographic shimmer effect to swatch cards`
- `fix: repair chipped color wheel on Safari`
- `refactor: buff and polish the API client code`
- `docs: nail down installation instructions`
- `test: apply full coverage to color matching suite`

## Troubleshooting

**AI suggestions not appearing?**
- Check which provider is detected: `sh -x .husky/generate-commit-msg.sh /tmp/test-msg`
- For Claude CLI: verify `claude` is in your PATH: `which claude`
- For Anthropic API: check key is set (without printing it): `printenv ANTHROPIC_API_KEY >/dev/null && echo set || echo not-set`
- For OpenAI API: check key is set: `printenv OPENAI_API_KEY >/dev/null && echo set || echo not-set`
- Both API providers require `jq`: `which jq`
- Verify the script is executable: `ls -l .husky/generate-commit-msg.sh`

**Pre-commit hook failing?**
- Ensure workspace packages have test scripts or they use `--if-present` flag
- Run manually to debug: `npm test`
