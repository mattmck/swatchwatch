# Husky Git Hooks

This directory contains git hooks for SwatchWatch that enforce code quality and provide vibey commit message suggestions.

## Hooks

- **pre-commit**: Runs `npm test` to ensure all tests pass before committing
- **commit-msg**: Validates commit messages follow Conventional Commits format via commitlint
- **prepare-commit-msg**: Generates vibey commit message suggestions based on staged changes

## AI-Powered Commit Messages

The `prepare-commit-msg` hook can use Claude (if configured) to generate vibey commit message suggestions based on your staged changes.

### Setup

To enable AI-generated suggestions, set your Anthropic API key:

```bash
# Add to your ~/.zshrc or ~/.bashrc
export ANTHROPIC_API_KEY="your-api-key-here"
```

Get your API key from: https://console.anthropic.com/settings/keys

### How It Works

1. When you run `git commit`, the hook analyzes your staged changes
2. It sends the diff to Claude with a prompt for nail-polish-themed suggestions
3. Claude generates 3 creative commit message options
4. The suggestions appear as comments in your commit message editor
5. Pick one, customize it, or write your own!

### Fallback

If no API key is set, the hook provides smart fallback suggestions based on file patterns:
- `package.json` changes → dependency update messages
- `.tsx/.ts` changes → component/feature messages  
- Test file changes → testing messages
- Documentation changes → docs messages
- Style file changes → UI/styling messages

### Example Output

```
# AI-generated nail polish commit suggestions:
#
# - chore: buff up test runner with glossy new polish
# - fix: repair chipped husky hook configuration
# - refactor: apply smooth top coat to commit workflow
#
# Pick one, customize it, or write your own.
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
- Check that `ANTHROPIC_API_KEY` is exported (without printing it): `printenv ANTHROPIC_API_KEY >/dev/null && echo set || echo not-set`
- Verify the script is executable: `ls -l .husky/generate-commit-msg.sh`
- Check for errors: `sh -x .husky/generate-commit-msg.sh .git/COMMIT_EDITMSG`

**Pre-commit hook failing?**
- Ensure workspace packages have test scripts or they use `--if-present` flag
- Run manually to debug: `npm test`
