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
│   ├── new/page.tsx           → /polishes/new     Add polish form + Rapid Add capture scaffold controls
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
| `color-wheel.tsx` | Canvas HSL color wheel with hover preview, click selection, snap-to-collection dots, harmony target diamonds, and external hover marker for bidirectional color highlighting |
| `color-search-results.tsx` | Polish list sorted by OKLAB color distance, with harmony match indicators and bidirectional hover callbacks |
| `harmony-palette.tsx` | Two-bar harmony display: "Target" bar (ideal harmony colors) + "My Collection" bar (closest owned polish for each target). Both bars support hover → wheel marker and click → select. |

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
| `constants.ts` | `FINISHES` — canonical finish types for dropdowns |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB↔OKLCH conversions, `colorDistance()`, `complementaryHex()`, gamut clamping |
| `color-harmonies.ts` | `HARMONY_TYPES`, `HarmonyType`, `generateHarmonyColors()` — 7 color theory harmonies via OKLCH |
| `api.ts` | Typed fetch wrappers: `listPolishes`, `getPolish`, `createPolish`, `updatePolish`, `deletePolish`, `searchCatalog`, `getShade`, `startCapture`, `addCaptureFrame`, `finalizeCapture`, `getCaptureStatus`, `answerCaptureQuestion` |

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `swatchwatch-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.
