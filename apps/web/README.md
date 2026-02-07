# Web App — `apps/web`

Next.js 16 (App Router) + Tailwind v4 + shadcn/ui.

## Running

```bash
# From repo root
npm run dev:web          # → http://localhost:3000
npm run build:web        # Production build
```

## Route Structure

```
src/app/
├── (dashboard)/page.tsx       → /           Dashboard with stats, recent additions
├── polishes/
│   ├── page.tsx               → /polishes         Inventory table (search, filter, sort)
│   ├── new/page.tsx           → /polishes/new     Add polish form
│   ├── [id]/page.tsx          → /polishes/:id     Polish detail view
│   └── search/page.tsx        → /polishes/search  Color wheel search
├── layout.tsx                 → Root layout (AppShell wrapper)
└── globals.css                → Tailwind v4 + shadcn/ui CSS variables
```

The `(dashboard)` route group provides the homepage without adding `/dashboard` to the URL.

## Components

### Custom (`src/components/`)

| Component | Purpose |
|-----------|---------|
| `app-shell.tsx` | Sidebar navigation (desktop) + header nav (mobile) |
| `color-dot.tsx` | Colored circle swatch — `sm`, `md`, `lg` sizes |
| `color-wheel.tsx` | Canvas HSL color wheel with hover preview + click selection |
| `color-search-results.tsx` | Polish list sorted by OKLAB color distance |

### shadcn/ui (`src/components/ui/`)

Installed components: `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `select`, `separator`, `table`.

Add more with:
```bash
cd apps/web && npx shadcn@latest add <component-name>
```

## Utilities (`src/lib/`)

| File | Exports |
|------|---------|
| `utils.ts` | `cn()` — Tailwind class merging (shadcn standard) |
| `mock-data.ts` | `MOCK_POLISHES`, `getPolishById()`, `BRANDS`, `FINISHES` — prototype data using shared `Polish` type |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB conversions, `colorDistance()`, `complementaryHex()` |

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `polish-inventory-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** Currently mock data in `src/lib/mock-data.ts`. When API is connected, replace with `fetch("/api/polishes")` calls — the types are already aligned
