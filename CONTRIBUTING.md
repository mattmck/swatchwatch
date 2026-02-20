# Contributing to SwatchWatch

## Git Workflow

We use **GitHub Flow** — a simple branch-based workflow:

```
main (always deployable)
  └── feat/42-catalog-search   ← your working branch
```

### Branch Naming

```
<type>/<issue#>-<short-description>
```

| Type | Use for |
|------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Maintenance, deps, CI |
| `docs/` | Documentation only |
| `refactor/` | Code improvement, no behavior change |
| `test/` | Adding or updating tests |

Examples: `feat/12-catalog-search`, `fix/34-color-wheel-safari`, `chore/update-deps`

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Cosmos DB client for polishes container
fix: color wheel not rendering on Safari
docs: update API route table in functions README
chore: bump shadcn/ui to 3.9
refactor: extract polish service from route handler
test: add OKLAB distance unit tests
```

Reference issues when relevant: `feat: add Cosmos DB client (#12)`

### Pull Requests

1. Create a branch from `main`
2. Make your changes with conventional commits
3. Open a PR — the template will guide you through the checklist
4. PRs are **squash merged** into `main` (one clean commit per feature)
5. Branches are auto-deleted after merge

**PR title must be a conventional commit** — it becomes the squash commit message.

### Issues

Use GitHub Issues for all work items. Pick the right template:

- 🚀 **Feature** — new functionality
- 🐛 **Bug** — something is broken
- 🔧 **Chore** — maintenance, deps, CI

Add scope labels (`web`, `mobile`, `functions`, `infra`) to help with filtering.

## Development Setup

```bash
git clone https://github.com/mattmck/swatchwatch.git
cd swatchwatch
npm install
npm run build:shared                         # build shared types first
npm run dev:web                              # start web dev server
```

See the [root README](README.md) for full setup instructions.

## Code Standards

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Shared types** go in `packages/shared/src/types/` — never duplicate domain types locally
- **Web components** — use shadcn/ui primitives from `src/components/ui/`, custom components in `src/components/`
- **Color math** — use OKLAB via `src/lib/color-utils.ts` for any perceptual color operations
- Run `npm run typecheck` and `npm run lint` before pushing

## Documentation

**Update docs as part of every PR** — not as a follow-up.

If your change adds/removes/modifies any of the following, update the corresponding doc:

- **Routes or pages** → `apps/web/README.md` + `CLAUDE.md` route table
- **API endpoints** → `packages/functions/README.md`
- **Shared types** → `packages/shared/README.md`
- **Components** → `apps/web/README.md`
- **Env variables** → `CLAUDE.md` + `packages/functions/README.md`
- **Infrastructure** → `infrastructure/README.md`
- **Dev commands** → root `README.md` + `CLAUDE.md`

The PR template checklist includes a docs checkbox — reviewers should verify it.

### AI Agent Instructions

The canonical agent instruction file is `CLAUDE.md`. All other agent files are symlinks:

| Agent | File |
|---|---|
| Claude Code | `CLAUDE.md` (canonical) |
| GitHub Copilot | `.github/copilot-instructions.md` → `CLAUDE.md` |
| Cursor | `.cursorrules` → `CLAUDE.md` |
| Windsurf | `.windsurfrules` → `CLAUDE.md` |
| Aider / others | `AGENTS.md` → `CLAUDE.md` |

Only edit `CLAUDE.md` — the symlinks keep everything in sync automatically.

## Future: GitFlow Migration

When the project grows to need parallel release tracks, we'll migrate to GitFlow:

```
main        ← production releases (tagged)
develop     ← integration branch
  ├── feature/*
  ├── release/*
  └── hotfix/*
```

Until then, GitHub Flow keeps things simple. The branch naming conventions above are already compatible — we'll just add `develop` as the default branch and gate `main` behind release merges.
