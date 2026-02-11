# SwatchWatch — Brand Visual Improvements Plan

> What's done, what's next, and what will take us from "looks branded" to "looks like a real product."

---

## What's Already Shipped (this branch)

| Area | What changed |
|---|---|
| **Theme tokens** | Every shadcn token remapped from neutral gray to brand pink/purple OKLCH palette. Light + dark mode. |
| **Brand utilities** | `.bg-gradient-brand`, `.text-gradient-brand`, `.glass`, `.shimmer`, `.shadow-glow-*` |
| **Icon system** | 4 clean geometric SVG icons (monogram drop, app squircle, swatch fan, bottle silhouette) rendered from shared TS specs |
| **Wordmark** | Two-tone "Swatch" (ink) + "Watch" (purple). Bold, tight tracking, no gimmicks. |
| **Lockup** | Drop mark + wordmark, static SVG + React component |
| **Favicon** | SVG monogram (replaces generic .ico) |
| **OG image** | 1200x630 branded gradient with lockup + tagline |
| **PWA manifest** | Brand name, theme color, icon references |
| **Route structure** | `(marketing)/` for landing page, `(app)/` for authenticated routes |
| **Landing page** | Hero, features grid, color showcase, stats, CTA footer |
| **App shell** | Lucide icons, brand wordmark in sidebar, `/dashboard` route |
| **Dashboard stats** | KPI cards now have gradient accent rails, Lucide icons, and text-gradient values. |
| **Add Polish form** | Quick color swatch palette, gradient-filled rating stars, and gradient CTA button. |
| **Collection filters** | Checkbox filters replaced with pill toggles that reuse the branded button styling. |

---

## Phase A: Typography & Polish (high impact, low effort)

### A1. Custom web font
- Add **Inter** (or DM Sans / Plus Jakarta Sans) via `next/font/google`
- Replace the current `system-ui` fallback stack with the loaded font
- Gives instant "designed, not default" feel
- Update font variables in `globals.css` and brand SVGs
- [x] Completed (2026-02-11): Inter is loaded in root layout, `body` uses `font-sans`, and static brand SVG text uses an Inter-first stack instead of `system-ui`.

### A2. Landing page headline typography
- Hero headline could use larger type on desktop (7xl/8xl) with finer weight modulation
- Consider alternating font weights within the headline ("Your polish collection" in medium, "beautifully organized" in extrabold) for visual rhythm
- Add subtle entry animation (fade-up on scroll) to hero content
- [x] Completed (2026-02-11): Hero headline now scales up to 8xl on wide screens, keeps split-weight rhythm, and uses staged `ScrollFadeIn` fade-up reveals for icon/headline/copy/CTAs.

### A3. Consistent heading hierarchy across app pages
- Dashboard, polish list, detail pages all use slightly different heading sizes and spacing
- Define a scale: page title = `text-2xl font-bold`, section = `text-lg font-semibold`, card title = `text-base font-medium`
- Apply consistently via shared component or Tailwind @apply
- [x] Completed (2026-02-11): Added shared heading utility classes in `globals.css` (`heading-page`, `heading-section`, `heading-card`) and normalized app page H1s + `CardTitle` styling to that scale.

---

## Phase B: Component Refinement (medium effort)

### B1. Branded stat cards on Dashboard
- [x] Subtle gradient border/left accent stripe in brand pink/purple
- [x] Stat values use `text-gradient-brand` for visual pop
- [x] Icons in stat cards (Droplets, Building2, Star, Sparkles)

### B2. Polish list table visual upgrade
- Add row hover effect with faint pink tint (`hover:bg-brand-pink-light/20`)
- Color swatch column: make the dot slightly larger, add ring shadow
- Finish badge: use brand-colored variants instead of default gray secondary
- Consider sticky header row with glass effect
- [x] Filters now use branded pill toggles with shared button micro-interactions
- [x] Completed (2026-02-11): Row hover tint, larger ringed swatches, finish-specific brand badge variants, and sticky glass header are all implemented on `/polishes`.

### B3. Polish detail page enhancements
- Hero-style color display: large swatch as background gradient behind polish name
- Color metadata section with visual OKLCH breakdown (lightness bar, chroma indicator, hue wheel position)
- Related/similar shades section using the existing color distance API
- [x] Completed (2026-02-11): Detail page now includes hero swatch treatment, an OKLCH color profile card with visual bars, and a related shades list ranked by perceptual `colorDistance`.

### B4. Color search page refinements
- The OKLCH color wheel is functional but visually stark
- Add a branded frame/container around the wheel
- Harmony results could use glass cards instead of plain borders
- Selected color should glow (`.shadow-glow-brand`)
- [x] Completed (2026-02-11): Added branded wheel framing, glass-styled harmony recommendation cards, and glow-forward selected-state markers in the color search experience.

### B5. Form styling (Add Polish page)
- [x] Input focus rings already use brand ring color from theme (no change needed)
- [x] Color picker integration: quick swatch grid with brand-styled selected state
- [x] Star rating: custom gradient SVG stars replace text glyphs
- [x] Submit button uses `.bg-gradient-brand` for the primary CTA

---

## Phase C: Landing Page Elevation (medium-high effort)

### C1. Animation & motion
- Scroll-triggered fade-in for each section (Intersection Observer or `framer-motion`)
- Hero decorative circles: subtle floating animation (translateY oscillation)
- Feature cards: staggered entrance animation
- Stats counters: animated count-up on scroll into view
- [x] Completed (2026-02-11): Added `ScrollFadeIn` reveal motion across landing sections, floating hero decorative circles, staggered feature card entries, and scroll-activated stat count-up animation.

### C2. Richer color showcase section
- Replace static polish cards with an interactive mini-demo
- Show a small color wheel with 3-4 dots and harmony lines connecting them
- Or: animate swatches "dropping" into a collection grid
- This section should sell the product's core value prop visually
- [x] Completed (2026-02-11): Replaced static swatch cards with an interactive harmony demo featuring a mini color wheel, connected palette nodes, and animated suggested-set swatches.

### C3. Social proof / testimonial section
- Even placeholder quotes give credibility
- Glass cards with avatar circles, quote text, name/handle
- Carousel or 2-3 static cards
- [x] Completed (2026-02-11): Added a dedicated social proof section with three glass testimonial cards, avatar initials, handles, and role/context labels.

### C4. Mobile responsiveness audit
- Hero padding and type scale on small screens
- Feature cards: single column on mobile with adjusted spacing
- Marketing header: hamburger menu or simplified nav at small widths
- CTA buttons: full-width on mobile
- [x] Completed (2026-02-11): Hero/section spacing and typography were retuned for small screens, feature/showcase/stat card spacing was tightened for mobile, and marketing header now uses a compact hamburger dropdown at small breakpoints.

### C5. Dark mode for marketing pages
- Currently the landing page doesn't have a theme toggle
- The dark tokens are defined — add a toggle or respect system preference
- Hero gradient needs dark variant (already defined in `.dark` but untested visually)
- [x] Completed (2026-02-11): Added a marketing header theme toggle (system/light/dark), persisted preference in localStorage, and wired `.dark` class application so marketing pages can be previewed in dark mode with existing tokenized gradients.

---

## Phase D: Brand Consistency Deep-Dive (higher effort)

### D1. Error states & empty states
- Loading spinner: replace text "Loading..." with a branded spinner (rotating monogram icon or pulsing drop)
- Error cards: use destructive red but with brand-consistent rounded corners and typography
- Empty collection state: illustrated drop icon + encouraging copy + CTA to add first polish
- [x] Completed (2026-02-11): Upgraded `BrandSpinner`, `ErrorState`, and `EmptyState` to branded card treatments and replaced remaining plain-text route fallbacks (`/polishes/new`, `/polishes/detail`, color search loading, and dashboard empty collection surface).

### D2. Notification / toast styling
- shadcn Sonner toasts should inherit brand colors
- Success: green with brand border radius
- Info: brand purple tint
- Error: stays destructive red
- [x] Completed (2026-02-11): Added a global branded Sonner `Toaster` with success/info/error variants and replaced destructive alert messaging in polish detail actions with styled toast feedback.

### D3. Micro-interactions
- Button hover: scale(1.02) + shadow transition on CTA buttons
- Card hover: lift effect (translateY(-2px) + increased shadow)
- Nav items: underline slide-in animation on active state
- Polish swatch dots: subtle scale on hover
- [x] Completed (2026-02-11): Added consistent button hover scaling, card lift-on-hover transitions, nav underline slide-in active states, and subtle hover scaling on polish swatch dots.

### D4. Sidebar refinement
- Sidebar logo area: add a faint gradient divider or brand accent line
- Active nav item: use a filled pill with brand pink-soft background instead of secondary
- Collapsed state (future): icon-only mode at narrow breakpoints
- User avatar / settings section at bottom of sidebar
- [x] Completed (2026-02-11): Added a gradient accent divider in the sidebar logo area, upgraded active nav items to a branded filled-pill treatment, and introduced a bottom avatar/settings module (collapsed icon-only mode remains future scope).

---

## Phase E: Asset Pipeline & Optimization

### E1. SVG sprite system
- Bundle the 4 brand icons into a single SVG sprite `<symbol>` sheet
- Reduces HTTP requests and enables easier icon reuse in non-React contexts
- The current inline SVG approach works but doesn't scale to 10+ icons
- [ ] Evaluate and implement SVG sprite strategy for reusable brand icons.

### E2. OG image variants
- Per-page OG images (dashboard preview, collection preview)
- Consider using `@vercel/og` or similar for dynamic OG generation if we move off static export
- [ ] Add page-specific OG variants for key app surfaces.

### E3. Preload critical assets
- `<link rel="preload">` for the brand font
- Preconnect to font CDN if using Google Fonts
- Ensure the monogram SVG favicon loads fast (it's tiny, but verify)
- [ ] Add and verify critical asset preload/preconnect optimizations.

---

## Suggested Execution Order

| Priority | Phase | Why |
|---|---|---|
| 1 | A1 (custom font) | Biggest visual upgrade for smallest code change |
| 2 | A2 + A3 (typography consistency) | Makes everything feel intentional |
| 3 | B1 + B5 (stat cards + form styling) | The pages users see most |
| 4 | C1 (landing animations) | Makes the marketing page feel alive |
| 5 | C4 (mobile audit) | Many visitors will see mobile first |
| 6 | B2 + B3 (polish list + detail) | Core app experience |
| 7 | D1 (error/empty states) | Edge cases that currently look unfinished |
| 8 | C2 + C3 (showcase + social proof) | Landing page depth |
| 9 | D3 + D4 (micro-interactions + sidebar) | Delight layer |
| 10 | E1-E3 (optimization) | Performance polish after visual polish |
