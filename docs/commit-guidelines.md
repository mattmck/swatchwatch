# Nail Polish-Themed Commit Messages 💅

SwatchWatch enforces nail polish-themed commit messages using commitlint and Husky. Every commit must follow Conventional Commits format AND include nail polish references.

## Format
```
<type>: <subject with nail polish theme>
```

### Emojis (optional)
Emojis are allowed anywhere in the subject, as long as they appear after `type: ` (i.e. don’t put emojis before the type).
Examples:
- `feat: ✨ add holographic shimmer to swatch cards`
- `feat: add holographic shimmer to swatch cards ✨`

## Valid Types

`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`, `perf`, `ci`, `build`, `revert`

## Required: Nail Polish Theme

Your commit subject MUST include at least one reference to:

### Colors
red, blue, pink, purple, green, yellow, orange, teal, coral, nude, beige, black, white, silver, gold, chrome, shimmer, glitter, metallic, pearl, holographic, iridescent, duochrome, multichrome

### Polish Terms
polish, lacquer, coat, topcoat, basecoat, gel, manicure, nail, swatch, finish, formula, shade, bottle, brush, chip, peel, cure, dry, glossy, sparkle, shine

### Polish Puns & Actions
buff, file, apply, remove, strip, layer, blend, paint, varnish, enamel, pigment, hue, tint, nailed it, nail down, polished, shiny, smooth, flawless, pristine, glazed, lacquered, painted, coated

### Brand/Collection Terms
collection, brand, dupe, compare, match, swatch, catalog, inventory, stash, haul

## Examples

### ✅ Good Commits

```bash
feat: add glossy topcoat to polish detail view
fix: chip in color matching algorithm
refactor: polish the swatch rendering logic
docs: nail down API endpoint documentation
feat: ✨ layer holographic finish over base coat component
fix: remove polish from deprecated auth flow
chore: buff up TypeScript configs across workspaces
test: apply coverage to color blend functions
style: coat UI components with Tailwind v4 💅
perf: cure slow database queries with indexes
ci: paint GitHub Actions with Azure deploy steps
```

### ❌ Bad Commits (Will be rejected)

```bash
feat: add new detail view               # No polish theme!
fix: update color matching               # Too generic
refactor: improve rendering logic        # Missing the vibe
docs: update API documentation          # Where's the pun?
```

## Testing Locally

Test your commit message before committing:

```bash
echo "feat: ✨ add shimmer effect to swatch cards" | npx commitlint
```

## Bypass (Emergency Only)

If you absolutely must bypass (not recommended):

```bash
git commit --no-verify -m "your message"
```

## Tips for Great Nail Polish Commits

- Use color names: "purple hue picker", "chrome finish toggle"
- Embrace puns: "polish the code", "nailed the bug", "coat with tests"
- Think like a manicurist: "apply", "remove", "layer", "buff", "file"
- Reference finishes: "matte mode", "glossy UI", "shimmer animation"
- Collections matter: "add coral collection", "inventory management", "swatch comparison"

Remember: If your nails aren't polished, your commits shouldn't be merged! 💅✨
