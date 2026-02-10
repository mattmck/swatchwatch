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
├── (marketing)/
│   ├── layout.tsx                → Marketing layout (glass header + footer)
│   └── page.tsx                  → /           Landing page (hero, features, CTA)
├── (app)/
│   ├── layout.tsx                → App layout (AppShell sidebar wrapper)
│   ├── dashboard/page.tsx        → /dashboard       Stats, recent additions
│   └── polishes/
│       ├── page.tsx              → /polishes         Inventory table
│       ├── new/page.tsx          → /polishes/new     Add polish form
│       ├── [id]/page.tsx         → /polishes/:id     Polish detail view
│       └── search/page.tsx       → /polishes/search  Color wheel search
├── layout.tsx                    → Root layout (fonts, metadata — no AppShell)
└── globals.css                   → Tailwind v4 + brand theme tokens + utility classes
```

**Route groups:**
- `(marketing)` — Public pages with minimal glass header + footer
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)

## Brand System

### Theme Tokens

All shadcn theme tokens in `globals.css` are mapped to the SwatchWatch brand palette (pink/purple). The palette source of truth is `packages/shared/src/branding/swatchwatch-brand.ts`.

**Brand palette Tailwind utilities:** `bg-brand-pink`, `text-brand-purple`, `border-brand-lilac`, etc.

### Brand Utility Classes

| Class | Effect |
|-------|--------|
| `bg-gradient-brand` | 135deg pink → purple gradient |
| `bg-gradient-brand-soft` | 135deg pink-soft → lilac gradient |
| `bg-gradient-hero` | Hero section gradient (light/dark aware) |
| `text-gradient-brand` | Gradient text (pink → purple) |
| `text-gradient-brand-vertical` | Vertical gradient text |
| `shadow-glow-pink` | Pink glow box-shadow |
| `shadow-glow-purple` | Purple glow box-shadow |
| `shadow-glow-brand` | Combined pink/purple glow |
| `glass` | Frosted glass effect (backdrop-blur, semi-transparent) |
| `shimmer` | Animated shimmer sweep overlay |

### Brand Components (`src/components/brand/`)

| Component | Purpose |
|-----------|---------|
| `SwatchWatchIcon` | Renders SVG brand icons (monogram, app, swatch, brush) |
| `SwatchWatchWordmark` | Icon + styled "SwatchWatch" text with gradient W |
| `SwatchWatchGraphicSet` | All 4 icons in a row |

## Components

### Custom (`src/components/`)

| Component | Purpose |
|-----------|---------|
| `app-shell.tsx` | Sidebar navigation (desktop) + header nav (mobile) with Lucide icons |
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
| `constants.ts` | `FINISHES` — canonical finish types for dropdowns |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB conversions, `colorDistance()`, `complementaryHex()` |

## Metadata & Assets

| Asset | Location | Notes |
|-------|----------|-------|
| Favicon (SVG) | `public/brand/swatchwatch-monogram.svg` | Referenced via metadata `icons` config |
| Apple Touch Icon | `public/apple-touch-icon.png` | 180x180 PNG from app icon SVG |
| OG Image | `public/og-image.png` | 1200x630 branded social preview |
| Manifest | `public/manifest.json` | PWA manifest with brand colors |
| Brand SVGs | `public/brand/` | Monogram, wordmark, lockup, swatch, brush, app icon |

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `swatchwatch-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.
