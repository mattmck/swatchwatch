# Web App — `apps/web`

Next.js 16 (App Router) + Tailwind v4 + shadcn/ui.

## Running

```bash
# From repo root
npm run dev:web          # → http://localhost:3000
npm run build:web        # Production build
npm run test --workspace=apps/web   # Web unit tests
```

## Route Structure

```
src/app/
├── (marketing)/
│   ├── layout.tsx                → Marketing layout (branded sticky header, responsive mobile menu, footer)
│   └── page.tsx                  → /           Landing page (hero, features, interactive showcase, testimonials, CTA)
├── (admin)/
│   ├── error.tsx                 → Route-group error boundary (full-screen `RouteError`; the group has no layout)
│   └── admin/
│       ├── page.tsx              → /admin  Unified admin console (tabs: Configuration, Job Runs, Admin Jobs, User Management, Review Queue, Hex Labeling). Renders with RequireAuth + AppShell at the page level. The active tab lives in `?tab=` (deep-linkable; switching tabs updates it via `history.replaceState`); it is read with `useSearchParams()` inside a `<Suspense>` boundary so the static-export HTML never mismatches the client's first render.
│       └── reference-data/
│           ├── page.tsx          → /admin/reference-data  Legacy redirect → `/admin?tab=configuration`
│           └── components/
│               ├── jobs-tab.tsx  → Job Runs tab (list `/api/reference-admin/jobs`, status/error inspection, filtering)
│               ├── config-tab.tsx → Configuration tab (finish/harmony CRUD + finish-normalization alias CRUD). Deleting an in-use finish type shows the API's 409 message (usage counts) in the delete dialog (`runReferenceDelete`). Renaming a finish type keeps the edit dialog open with the result ("Renamed "chrome" to "mirror"; 12 shades updated, …", `finishTypeRenameNotice`) or the 409 "already exists" message (`runReferenceUpdate`)
│               ├── users-tab.tsx → User Management tab (`/api/users-admin` list + `/api/users-admin/merge` repair flow)
│               ├── review-queue-tab.tsx → Review Queue tab (`?tab=review-queue`): pending/rejected `user_submitted` shades from `/api/shades-admin/review`, side-by-side comparison (swatch chips, catalog swatch image, field diff, ΔE) against fuzzy merge candidates with a catalog name search, and approve / edit & approve / merge (confirmed) / reject actions
│               └── hex-labeling-tab.tsx → Hex Labeling tab (`?tab=hex-labeling`): ground-truth hex labeler for the hex-detection eval (see below)
├── (app)/
│   ├── layout.tsx                → App layout (AppShell sidebar wrapper)
│   ├── error.tsx                 → Route-group error boundary (renders `RouteError` inside the AppShell; retry = `reset()`)
│   ├── admin/jobs/page.tsx       → /admin/jobs      Legacy route redirect to `/admin?tab=admin-jobs`
│   ├── dashboard/
│   │   ├── page.tsx              → /dashboard       Stats, "Pick for me" card, recent additions (computed from full paginated inventory; "By Finish" counts a multi-finish polish once per finish). Wishlist count (list `total` of `GET /api/polishes?status=wishlist&pageSize=1`) and untried % of owned (`summarizeCollection()` over the owned rows already loaded) tiles link to the filtered table; emits a `collection.summary` telemetry event; then the collection stats panels (`<CollectionStatsSection />`, #271)
│   │   └── opengraph-image.tsx   → /dashboard OG image route
│   ├── manis/page.tsx            → /manis           Mani log (#269): calendar strip of the last 6 weeks (Monday-first; swatch dots per day; tap a worn day to filter the list, an empty day to log a mani on it), history newest first with "Show more" paging, edit/delete per mani (owner-scoped photo via `PrivateImage` when one is attached), and the "Log a mani" dialog (`ManiLogForm`, with an optional private photo, #327). `?log=<shadeId>` opens the dialog with that polish picked
│   └── polishes/
│       ├── page.tsx              → /polishes         Global polish catalog + personal inventory overlay (server-side paging/filter/sort with URL-synced state; search is debounced 350ms and refetches keep the page mounted, dimming the table instead of swapping in a spinner; tone filter uses a fallback full-fetch path; ownership filters are one URL `status=` list (All / My Collection / Wishlist presets + multi-select status menu) plus an `untried=1` toggle, with legacy `scope`/`availability`/`all` links mapped once and rewritten (`lib/polish-list-url.ts`); each row shows a status chip and "Untried" badge, and `CollectionQuickActions` (♡ wishlist, ✓ own, stepper, ⋯ menu for status/tried date) updates optimistically with rollback; − on the last bottle (or ⋯ → Archived on an owned row) archives the polish and shows the archive toast (`showArchivedToast`: Used up · Gave away · Undo); ♡ on an archived row is the Rebuy (→ wishlist); detail/edit flows carry `returnTo` context; swatch thumbnails open full image; catalog and wishlist rows (anything not owned) show a "Dupe owned" / "Near dupe owned" hint linking to the best owned dupe, loaded per page with one `POST /api/polishes/dupes` call via `useDupeHints`; the row Add / "✓ Own" / ♡ wishlist quick actions run the add guard (#266), skipping the dupe call when the row's hint already says "no dupe"; admins see per-row "Recalc Hex" action; "Import" button → `/polishes/import`; color family chips (`?family=red,pink`, server-side `family` filter, kept in the same URL state); rows with an API `buyUrl` show a "Buy from brand" link under the name; owned rows get a one-tap "Log today's mani" icon next to the quick actions; with the Wishlist preset it shows `WishlistShareCard`; header "Export" menu downloads the whole collection as CSV or JSON; a "Pick for me" header button opens the pick dialog)
│       ├── opengraph-image.tsx   → /polishes OG image route
│       ├── new/page.tsx          → /polishes/new     Add polish form (multi-select finish chips built from all reference finish types, so admin-added finishes are selectable; a polish's saved finishes missing from the list stay visible and selected on edit; first selected = primary finish, sent as `finishes` + legacy `finish`; inventory `status` select plus purchase price/currency, cleared with `null` on edit; saving as Owned/Wishlist — on create, or on edit when the status changes into one of them — runs the add guard (#266): edit uses `GET /api/polishes/{id}/dupes`, create compares the entered hex/finishes against the owned shades from `GET /api/polishes?status=owned` with the shared dupe rule)
│       ├── detail/page.tsx       → /polishes/detail  Polish detail view (incl. inventory status / untried, purchase price, and "Worn N× · last <date>" from the mani log) + "You own N close dupes" callout (`GET /api/polishes/{id}/dupes`: owned dupes with swatches, links, grade badges and finish compatibility) + one-tap "Log today's mani" + "Log a mani with this polish" link (`/manis?log=<id>`) + private nail photo (beside vendor/AI swatches) + image preview + OKLCH profile + related shades + "Buy from brand" button when the API returns a `buyUrl` + "Rebuy" (archived → wishlist) on archived polishes. `&archived=1` (set by the edit form after saving an owned polish with 0 bottles) shows the archive toast once
│       ├── gaps/page.tsx         → /polishes/gaps    Collection gap map heatmap (8 hue families × 5 lightness bands, missing/thin coverage, next-buy suggestions, deep-link into color search); loads owned rows first, then the shared catalog in the background for "Available To Add"
│       ├── import/
│       │   ├── page.tsx          → /polishes/import  CSV import wizard (#263): upload (drag-and-drop / file picker, 1 MB / 1000 rows, `.xlsx` rejected with "save as CSV") → column mapping (header row picker + per-column field select, pre-filled by the shared header detection; required when detection is unsure) → `POST /api/polish-imports` → review tabs (Matched / Needs review / Not in catalog / Can't import) with a per-row candidate picker (swatch, confidence, "in collection" / "private" badges), catalog search to re-match, "add as a new private shade" / skip, bulk actions; rows with quantity 0 and no status start undecided (D5b) with a per-row "wishlist / archived — used up / archived — gave away" select and bulk "Mark as wishlist" / "Mark as archived" (Used up · Gave away reason toggle); undecided ones are left out of the import count and skipped → `POST …/commit` → summary (added / updated / skipped / failed). `?session=<id>` resumes a review after reload
│       │   └── import-components.tsx → `CsvDropZone` (with a template download), `HeaderRowSelect`, `ColumnMappingTable`, `ReviewTable`, `CatalogSearchDialog`
│       ├── match/
│       │   ├── page.tsx          → /polishes/match   Photo match: choose/drop/take a photo → client-side downscale (`lib/image-downscale.ts`) → `POST /api/polishes/match-image`; shows preview, extracted palette (click a swatch to filter matches to that color), and owned polishes ranked by OKLAB distance with confidence badges
│       │   ├── match-components.tsx → `ImageDropZone` (drag-and-drop + file picker + `capture` camera input), `ImagePreview`, `ExtractedPalette`, `ConfidenceBadge`, `MatchResultsList`
│       │   └── match-utils.ts    → Confidence badge metadata, match % (same 0.5 normalization as search), per-color filtering/counting
│       └── search/page.tsx       → /polishes/search  Color wheel search (two-column layout, collapsible wheel/harmonies, single full-width harmony-only selector with All mode, one-click swatch focus, focus workflow, standardized Brand/Tone/Finish/Availability dropdown filters; the result-row Add button runs the add guard (#266))
├── rapid-add/
│   ├── layout.tsx                → RequireAuth + AppShell (the route sits outside `(app)` but calls the authenticated capture API)
│   └── page.tsx                  → /rapid-add  Camera-first Rapid Add: live rear camera (`getUserMedia`) with on-device barcode scanning (`BarcodeDetector`, lazy zxing fallback), Label/Barcode/Color shutter, photo-upload fallback, frames sent to `POST /api/capture/{id}/frame` with per-frame retry, adaptive capture questions as buttons, then a verdict card (already own it / added / not found → add). Owned-verdicts offer "I didn't buy another" (restores the pre-scan quantity). Shows the mobile install prompt
├── w/
│   ├── page.tsx                  → /w/?token=…  Public shared wishlist (#268): no auth, no AppShell, `robots: noindex,nofollow` + `referrer: no-referrer` metadata, no OG/Twitter cards. Static export has no dynamic segments, so the token is a query parameter (same pattern as `/polishes/detail?id=`), not `/w/{token}`. Shows nothing but the API's 404 message while `SHAREABLE_WISHLIST_ENABLED` is off
│   └── public-wishlist-client.tsx → Reads `?token=`, calls `GET /api/wishlist/{token}` without credentials, renders swatch cards (display hex fill, public catalog thumbnail, brand, shade, finish badges); 404/429 get viewer-friendly messages
├── global-error.tsx              → Last-resort error boundary for the root layout (own <html>/<body>, inline styles; reports via `trackException`)
├── layout.tsx                    → Root layout (fonts, metadata, AuthProvider → TelemetryProvider — no AppShell)
└── globals.css                   → Tailwind v4 + brand theme tokens + utility classes
```

**Route groups:**
- `(marketing)` — Public pages with branded sticky header + footer
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)
- `(admin)` — Admin-only app routes that render with `RequireAuth` + `AppShell` at the page level

## Brand System

### Theme Tokens

All shadcn theme tokens in `globals.css` are mapped to the SwatchWatch brand palette (pink/purple). The palette source of truth is `packages/shared/src/branding/swatchwatch-brand.ts`.

**Brand palette Tailwind utilities:** `bg-brand-pink`, `text-brand-purple`, `border-brand-lilac`, etc.

### Typography

Inter is loaded via `next/font/google` in `src/app/layout.tsx` and applied globally with `font-sans` through the root `<body>` class.

Static text assets use the same Inter-first fallback stack:
- `public/brand/swatchwatch-wordmark.svg`
- `public/brand/swatchwatch-lockup.svg`
- `public/og-image.svg`

Shared heading scale utilities are defined in `src/app/globals.css` and reused across app routes:
- `heading-page` → page titles (`text-2xl font-bold tracking-tight`)
- `heading-section` → section headings (`text-lg font-semibold tracking-tight`)
- `heading-card` → card titles (`text-base font-medium`)

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
| `marketing-surface` | Shared marketing panel surface (rounded border, card tint, soft brand shadow) |
| `marketing-surface-soft` | Softer accent panel for highlight blocks and active marketing states |
| `marketing-kicker` | Uppercase section label styling for marketing headings |
| `shimmer` | Animated shimmer sweep overlay |

### Brand Components (`src/components/brand/`)

| Component | Purpose |
|-----------|---------|
| `SwatchWatchIcon` | Renders SVG brand icons (monogram, app, swatch, brush) |
| `SwatchWatchSpriteIcon` | Renders symbols from `public/brand/swatchwatch-sprite.svg` for sprite-based icon usage |
| `SwatchWatchWordmark` | Icon + styled "SwatchWatch" text with theme-aware contrast in light/dark modes |
| `SwatchWatchGraphicSet` | All 4 icons in a row |

## Components

### Custom (`src/components/`)

| Component | Purpose |
|-----------|---------|
| `app-shell.tsx` | Sidebar navigation (desktop) + header nav (mobile) with exact active-route matching, branded active-nav pills, logo accent divider, app theme toggle, and `<UserCard>` footer with auth state. A single Admin link (`/admin`) is shown only for admin users & Gap Map, Photo Match, Mani Log and Rapid Add routes in primary navigation |
| `auth-provider.tsx` | MSAL provider wrapper with three modes: dev bypass (no MSAL), B2C via MSAL, unconfigured fallback. Manages token lifecycle and stores in module-level `auth-token.ts` |
| `require-auth.tsx` | Route guard for `(app)` routes. Dev bypass → render children; B2C unconfigured → show "Sign in" button; B2C authenticated → render children; unauthenticated → show "Sign in" button |
| `user-card.tsx` | Sidebar footer: displays user initials, name, email, and sign-out button. Conditionally uses `useAuth()` (B2C) or `useDevAuth()` (dev bypass) |
| `marketing-auth-button.tsx` | Header auth button: "Open App" when authenticated, "Sign In" when unauthenticated (B2C), always "Open App" in dev bypass |
| `brand-spinner.tsx` | Branded loading state with animated monogram spinner used across app route fallbacks |
| `error-state.tsx` | Reusable error card with destructive accent styling and optional retry action |
| `route-error.tsx` | `<RouteError error reset boundary />` — shared body of the route-group `error.tsx` boundaries: reports the error with `trackException` (`boundary`, `digest` properties) and renders `ErrorState` with `reset()` as the retry |
| `telemetry-provider.tsx` | Mounted in the root layout inside `AuthProvider`. Starts browser telemetry after hydration and tags it with the internal user id (resolved once per signed-in account via `POST /api/auth/validate`; never the email), clearing it on sign-out. Renders nothing extra when telemetry is off |
| `empty-state.tsx` | Reusable empty-state card with brand icon treatment and optional CTA |
| `marketing-color-showcase.tsx` | Interactive landing-page color harmony demo with mini wheel, connected swatch nodes, and animated suggested set tiles |
| `marketing-theme-toggle.tsx` | Reusable system/light/dark theme selector used in marketing and authenticated app shells |
| `color-family-chips.tsx` | `<ColorFamilyChips value onChange />` — multi-select color family filter: an "Any color" chip plus one `ToggleChip` per `COLOR_FAMILIES` entry with a swatch dot (`COLOR_FAMILY_SWATCH_HEX`; multichrome renders a conic gradient). Used on `/polishes` |
| `color-dot.tsx` | Colored circle swatch (`sm`/`md`/`lg`) with subtle hover scale micro-interaction |
| `color-wheel.tsx` | Canvas HSL color wheel with hover preview, click selection, owned-shade snap mode, and glow-forward selected marker |
| `finish-badges.tsx` | `<FinishBadges polish finishTypes? max? empty? />` — one branded badge per finish (multi-finish shades show several, overflow collapses into `+N`), falling back to the legacy single `finish`. Pass `finishTypes` (from `useReferenceData()`) to label badges with the reference `displayName`. Used by the polish table, detail page, dashboard recent additions, and color search results |
| `color-search-results.tsx` | Polish list sorted by OKLAB color distance, with branded finish badges, high-contrast focus-state swatch highlights, and harmony interactions (palette selection affects table targeting without mutating focused colors) |
| `buy-from-brand-link.tsx` | `<BuyFromBrandLink url brand? name? variant? />` — "Buy from brand" outbound link (#267) from the polish's API `buyUrl`. Opens in a new tab with `rel="noopener noreferrer nofollow"` (`OUTBOUND_LINK_REL` from swatchwatch-shared), re-checks the URL client-side via `outboundLinkProps()`, and renders nothing when there is no (safe) URL. `variant="inline"` (default, small text link) sits under the shade name in `/polishes` rows (catalog, collection and wishlist views); `variant="button"` is the outline button in the `/polishes/detail` header |
| `private-image.tsx` | `<PrivateImage src alt className? fallback? />` — renders owner-scoped private image ids (a `/api/images/v3.` path that is relative or on the API base URL's origin) by fetching them with the user's bearer token and showing an object URL, since `<img>` cannot send `Authorization`. Public URLs (including catalog `v2.` ids) render as a plain `<img>`; while loading it shows a neutral `aria-busy` placeholder, and on 401/403/error it shows `fallback` or an empty `role="img"` placeholder. Used by `nail-photo-panel.tsx` for private nail photos (#270) and for mani-log photos on `/manis` (#269) and in `ManiLogForm` (#327) |
| `photo-picker-buttons.tsx` | `<PhotoPickerButtons onFile chooseLabel disabled? children? />` — "Choose photo" (file input, `accept` = `NAIL_PHOTO_INPUT_ACCEPT`: the API's types plus `.heic`/`.heif`/`.hif`) and "Take photo" (`capture="environment"`) buttons with hidden inputs that reset after each pick; `children` adds buttons such as Delete. Shared by `NailPhotoPanel` and `ManiLogForm`; pair with `prepareNailPhotoUpload` |
| `nail-photo-panel.tsx` | `<NailPhotoPanel inventoryItemId polishLabel vendorHex? detectedHex? nameHex? />` — the caller's private on-nail photo for one inventory item (#270), shown beside the vendor / AI-detected swatch tiles on the polish detail page. Loads `GET /api/inventory/{id}/nail-photo`, renders the owner-scoped `v3` URL with `PrivateImage` (fallback with Retry on 401/403/error, which refetches a fresh signed URL), and offers "Choose photo" / "Take photo" (`PhotoPickerButtons`), Replace and Delete (confirm). Uploads go through `prepareNailPhotoUpload` (browser re-encode to JPEG ≤ 2048px, HEIC/HEIF converted in the browser, so EXIF/GPS never leaves the device); errors are mapped by `describeNailPhotoError`. Rendered only when the polish has an `inventoryItemId`, keyed by it |
| `hex-sampler.tsx` | Shared canvas eyedropper pieces for ground-truth hex labelling: `<ImageSampler src alt sampleSize marker onHover onPick />` (draws the image into a `<canvas>` with `crossOrigin="anonymous"`, magnifier loupe, sample-window outline, tainted-canvas fallback), `<HexSwatch />`, `getEyeDropperCtor()` (native `EyeDropper`), `formatDistance()` (OKLAB) and `isTextField()`. Used by `shade-hex-labeler.tsx`; pure maths stays in `lib/hex-sampling.ts` |
| `shade-hex-labeler.tsx` | `<ShadeLabeler item threshold sampleSize onSampleSizeChange saving onSave … />` — one shade's labeler (`HexLabelQueueItem` in, `HexLabelRequest` out): image strip, eyedropper, hex input, sample size, unreliable flag, note, Δ vendor / detected / name, Save. Queue navigation and undo (`onSkip` / `onNext` / `onPrev` / `onUndo`) and `onRemove` are optional (buttons and shortcuts appear only with a handler); `layout="split"` (tab) or `"stacked"`, `shortcutScope="window"` (tab) or `"panel"` (shortcuts only while focus is inside). Shared by the Hex Labeling tab and `AdminHexSipPanel` |
| `admin-hex-sip-panel.tsx` | `<AdminHexSipPanel shadeId />` — collapsed-by-default admin card on `/polishes/detail` (#351): "Sip ground-truth hex". Expanding it loads `GET /api/hex-labels-admin/shades/{shadeId}` (`getHexLabelShade`) and renders `ShadeLabeler`; Save posts and Remove deletes the shade's one manual label (`saveHexLabel` / `deleteHexLabel`). The detail page renders it through `<AdminHexSipSection shadeId />` (same dev-bypass / unconfigured / B2C `isAdmin` selection as the admin page), so non-admins render nothing and make no request |
| `install-prompt.tsx` | `<InstallPrompt />` — mobile-web "add to home screen" banner for `public/manifest.json`: replays a deferred `beforeinstallprompt` from an "Install app" button on Chromium, shows a Share → Add to Home Screen hint on iPhone/iPad, hidden on desktop, when installed (standalone), in in-app browsers, and for 14 days after "Not now" (`useInstallPrompt` in `hooks/use-install-prompt.ts`) |
| `rapid-add/camera-capture.tsx` | `<CameraCapture scanBarcodes captureDisabled frameType onFrameTypeChange onCapture onCameraError? />` — live viewfinder via `useCameraStream` (rear camera, unconstrained retry, released on stop/unmount/tab hide, auto-starts only when permission was already granted), live barcode scan loop that stops at the first valid retail code, shutter + photo upload (both run a thorough barcode pass on the still), and explicit permission-denied / no-camera / camera-busy / insecure-context / unsupported states with the upload fallback always available |
| `rapid-add/verdict-card.tsx` | `<VerdictCard verdict quantityRestored undoing onUndoQuantity onScanNext />` — renders a `CaptureVerdict` (`owned` / `added` / `add`) with an exhaustive switch, so new kinds (near-dupe #265, wishlist #261) must add a layout here |
| `rapid-add/frame-strip.tsx` | `<FrameStrip frames onRetry onRemove />` — thumbnails of the scan's frames with uploading/uploaded/failed state and Retry/Remove on failures |
| `rapid-add/capture-question-panel.tsx` | `<CaptureQuestionPanel question busy onAnswer onSkip onAction />` — capture API follow-up questions as buttons (candidate picks, "scan barcode" / "add label photo" camera actions), free text for brand + shade, and Skip |
| `quantity-controls.tsx` | `<QuantityControls owned quantity onIncrement onDecrement onAdd disabled? addPending? />` — table/search quantity stepper. Shows an Add button unless `owned` (`status === "owned"`, see `lib/inventory-status.ts`); `disabled` disables every button (e.g. while a row status change is in flight) and `addPending` disables Add with "Checking…" while the add guard's dupe check runs (#266); the last-bottle decrement shows an archive icon and moves the polish to `archived` (#262; the reason is recorded, D5c) |
| `add-guard-dialog.tsx` | `<AddGuardDialog guard onChoice returnTo? />` — add guard (#266) dialog (shadcn `Dialog`): the owned near-dupes of the shade being added or wishlisted as swatch pairs (shade ↔ owned dupe) with grade badge, finish compatibility, ΔE and a detail link; buttons Cancel / Wishlist instead (only when adding to the collection and the shade is not already wishlisted) / Add anyway (or "Wishlist anyway"), plus "Don't warn me for this shade again this session". Focus starts on Cancel; Esc, the close button, an overlay click or following a dupe link count as cancel. Driven by `useAddGuard()` |
| `status-chip.tsx` | `<StatusChip status />` — color-coded inventory status chip (Owned / Wishlist / Destash / Archived, or a dashed "Not added" for catalog-only rows); `<UntriedBadge />` for owned polishes with no `triedAt` (`Polish.isUntried`) |
| `collection-quick-actions.tsx` | `<CollectionQuickActions polish pending? onAction onQuantityChange />` — `/polishes` row actions (#262). Owned rows: bottle stepper. Other rows: ♡ wishlist toggle (`aria-pressed`; on catalog, wishlist and archived rows — un-hearting a wishlist row deletes its inventory row) and "✓ Own". Every row: a ⋯ Radix dropdown (keyboard-navigable) with a status radio group (Owned/Wishlist/Destash/Archived) and, for owned/destash/archived rows, "Mark tried today", "Mark tried on a date…" (dialog with a date input, no future dates) and "Mark as untried". All buttons carry the polish name in their `aria-label`. Emits `CollectionAction`s (`lib/collection-actions.ts`); the page applies them |
| `status-filter.tsx` | `<StatusFilter statuses untried onStatusesChange onUntriedChange />` — `/polishes` ownership filters: All / My Collection / Wishlist presets (`aria-pressed`), a multi-select status menu (checkbox items that keep the menu open) for any combination such as Destash + Archived, and an "Untried" toggle chip. Presets are shortcuts for the status list, so the URL has one source of truth |
| `archived-toast.tsx` | `showArchivedToast({ polish, onUpdated? })` — "Archived — Used up · Gave away · Undo" (decision D5c), shown after an owned polish is archived by running out (− on the last bottle or ⋯ → Archived in `/polishes`, − in `/polishes/search`, or saving 0 bottles in the edit form → detail page). The API already recorded `used_up`; Gave away sends `{ status: "archived", archiveReason: "decluttered" }`, Undo sends `{ status: "owned", quantity: 1, undoArchive: true }`; `onUpdated` receives the returned polish |
| `log-mani-button.tsx` | `<LogManiButton polish variant? onWearStatsChange? companions? onLogged? />` — one-tap "Log today's mani" (#269): `POST /api/manicures` dated the user's local today with this polish (toppers as `topper`, otherwise `color`) plus any `companions` (`{ id, role }`, e.g. "Pick for me" pairings), `onLogged(manicureId)` after a successful log, toast with Undo (`DELETE /api/manicures/{id}`), and the recomputed wear stats passed to `onWearStatsChange`. `variant="icon"` is the compact table-row form. Renders nothing for catalog-only rows (no inventory row) |
| `pick-for-me.tsx` | "Pick for me" (#272). `<PickForMeCard polishes />` is the dashboard card (fed the owned list the dashboard already loads); `<PickForMeButton />` is the `/polishes` header button that opens a dialog and loads the owned list on open; both render `<PickForMePanel polishes source />`. Shows the pick (swatch, name, brand, finish badges, reason chips such as "Untried", "Not worn in 3 months", "Fills a gap: deep teal"), **Pick again** (never repeats the last 3 picks of the session), **Pair it** (up to 2 owned harmonies from `suggestPairings()`, labeled with the reference harmony names) and `LogManiButton` with the shown pairings as companions. Empty state when nothing is owned. Telemetry: `pick_for_me_shown`, `pick_for_me_rerolled`, `pick_for_me_paired`, `pick_for_me_logged` (properties: `source` = dashboard/polishes, reason kinds, pool size, pairing count; no polish ids) |
| `mani-calendar-strip.tsx` | `<ManiCalendarStrip weeks selectedDate onSelectDay />` — Monday-first grid of recent weeks from `buildCalendarStrip()`; up to three swatch dots per day, today ringed, future days disabled |
| `mani-log-form.tsx` | `<ManiLogForm open onOpenChange todayIso collection collectionLoading manicure? initialDate? initialShadeIds? onSaved />` — "Log a mani" / "Edit mani" dialog: date (defaults to today, max tomorrow), polish picker searching the collection (owned + destash), a role select per picked polish (base/color/accent/topper/other; pick order = position), notes, and an optional private photo (#327: `PhotoPickerButtons`; the pick is prepared right away with `prepareNailPhotoUpload` (HEIC converted, metadata stripped) and previewed locally, a saved photo is shown with `PrivateImage`; Replace / Remove). Validates with `validateManiForm()` and saves via `createManicure` / `updateManicure` (edit replaces the polish list), then applies the photo change (`maniPhotoSaveAction()`: `uploadManicurePhoto` / `deleteManicurePhoto`); a failed photo upload keeps the saved mani and shows an error toast |
| `wishlist-share-card.tsx` | `<WishlistShareCard />` — owner controls for the opt-in public wishlist link (#268), shown on `/polishes` with the Wishlist filter: optional display name, create link, copy link, replace (rotate) and turn off (revoke), with confirm prompts and a privacy note (`wishlistSharePrivacyNote`). Calls `GET /api/wishlist-share` on mount and renders nothing when the server flag is off (`feature_disabled`) or the status can't be loaded |
| `collection-export-menu.tsx` | `<CollectionExportMenu />` — "Export" dropdown on `/polishes` (CSV / JSON). Downloads the caller's whole collection (every status) through `exportCollection()` in `lib/api.ts` (authenticated fetch → Blob → `saveBlobAsFile`), shows a spinner while pending and a toast on success/failure |
| `stats/collection-stats-section.tsx` | `<CollectionStatsSection className? />` — dashboard "Collection stats" (#271), self-contained (loads `GET /api/stats/collection` via `getCollectionStats()`): status totals line, one currency picker (`aria-pressed` buttons, shown only with 2+ currencies) shared by every money panel — amounts are never combined across currencies — and a retryable error row. Renders the panels below |
| `stats/stats-panel.tsx` | `<StatsPanel title description loading?>` card chrome (skeleton while `loading`), `<StatsSkeleton />`, `<StatsEmpty message actionLabel? actionHref? />`, and `<StatsTable caption columns rows />` — the collapsible "View as table" text alternative every chart carries (charts themselves are `aria-hidden`) |
| `stats/spend-by-brand-panel.tsx`, `stats/spend-by-month-panel.tsx` | `<SpendByBrandPanel stats currency />` (all-time, top 8 brands + "Other", horizontal bars with values at the tip) and `<SpendByMonthPanel stats currency />` (last 12 UTC months as columns; only the largest and latest months are labelled, every month has a hover title; notes how many undated purchases fell back to the month they were added). Single-series marks use `brand-purple` (validated against light and dark card surfaces) |
| `stats/worn-vs-waiting-panel.tsx` | `<WornVsWaitingPanel stats />` — SVG ring (filled arc = owned polishes worn at least once, track = never worn; `role="img"` with a full `aria-label`), legend with counts, and the untried % figure |
| `stats/most-worn-panel.tsx`, `stats/cost-per-wear-panel.tsx` | `<MostWornPanel stats />` (top 10 by wear count with swatches, last-worn date and a status badge for non-owned rows) and `<CostPerWearPanel stats currency />` (best / worst value lists, priced-but-unworn count). Rows link to the polish detail page |

### shadcn/ui (`src/components/ui/`)

Installed components: `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `select`, `separator`, `sonner`, `table`.

`button` includes a reusable `brand` variant for gradient CTAs shared across marketing and app surfaces.

`src/components/ui/sonner.tsx` provides the branded toast wrapper mounted in `src/app/layout.tsx`.

Add more with:
```bash
cd apps/web && npx shadcn@latest add <component-name>
```


## Auth System

**Dev Bypass Mode** (`NEXT_PUBLIC_AUTH_DEV_BYPASS=true`):
- Skips MSAL initialization entirely
- `getAuthHeaders()` returns `Bearer dev:1` (or `Bearer dev:2` for admin calls)
- All MSAL-dependent components render fallback/stub states

**B2C Mode** (when `NEXT_PUBLIC_B2C_TENANT` and `NEXT_PUBLIC_B2C_CLIENT_ID` are set):
- MSAL initializes via `PublicClientApplication` in `auth-provider.tsx`
- Login requests include OIDC scopes plus an API scope (`api://<client-id>/access_as_user` by default)
- User signs in → token stored in module-level `auth-token.ts`
- `getAuthHeaders()` reads token and sends it in `Authorization` header
- `<RequireAuth>` guard on `(app)` routes triggers login redirect if unauthenticated
- `<UserCard>` displays user info and sign-out button in sidebar

**Deterministic sign-out:** `useAuth().logout()` calls `logoutRedirect()` with explicit parameters so behavior is consistent in multi-account browser sessions:
- `account` — the active account (`getActiveAccount()`, falling back to the first cached account), so MSAL signs out the specific SwatchWatch session instead of prompting "which account to sign out of"
- `postLogoutRedirectUri` — `window.location.origin + "/"`, returning the user to the app root
- `logoutHint` — sourced from the account's `login_hint` optional claim when present (recommended), falling back to `account.username`, which can let the IdP skip the account picker entirely

This works for both `ciamlogin.com` (External ID) and `b2clogin.com` (legacy B2C) authorities. For the most reliable promptless logout, configure the `login_hint` optional claim on the Entra app registration so it is emitted in the ID token.

**Hooks:**
- `useAuth()` — B2C mode only, calls MSAL hooks (`useMsal`, `useIsAuthenticated`). Returns `{ isAuthenticated, user, role, isAdmin, login, logout }`. Must be inside `<MsalProvider>`
- `useDevAuth()` — Dev bypass stub, safe to call anywhere. Returns stubbed auth state with admin role for local testing
- `useUnconfiguredAuth()` — B2C-unconfigured stub, safe to call anywhere. Returns unauthenticated non-admin state

## Admin Hex Labeling tab

`/admin?tab=hex-labeling` (`reference-data/components/hex-labeling-tab.tsx`; the per-shade sampler UI lives in the shared `components/shade-hex-labeler.tsx` + `hex-sampler.tsx`, which `/polishes/detail` also uses for admins via `AdminHexSipPanel`, #351) builds ground-truth hexes for the hex-detection eval. It walks the admin queue from `GET /api/hex-labels-admin/queue` (unlabeled shades with images first, worst vendor↔detected agreement first; filters: brand, "Vendor ≠ detected" (`hex_agreement > 0.10`), "Show labeled", "Include no-image shades"; cursor-paginated, the next page is prefetched near the end) and shows, per shade, brand/name/finishes, the vendor/detected/name hexes as swatches with the OKLAB agreement, and every catalog product image (thumbnail strip, keys 1–9).

- **Eyedropper:** the selected image is drawn into a `<canvas>` (loaded with `crossOrigin="anonymous"`; the image proxy returns `Access-Control-Allow-Origin` for allowed web origins). Hovering shows a 10× magnifier loupe with the sample window and a live "Under cursor" swatch; clicking or tapping (pointer events, `touch-action: none`) picks the averaged colour of a 1×1/3×3/5×5/9×9/15×15/25×25/41×41/61×61 window (default 5×5, `[`/`]` to change), ignoring fully transparent pixels. The large windows average across glitter, flakies and shimmer; the sample window is also outlined on the image, and the loupe zooms out so the whole window stays visible. Chromium browsers also get a native `EyeDropper` button (E). If an image cannot be read (no CORS headers → tainted canvas) the tab still shows it and explains that only the native eyedropper or a typed hex will work.
- **Save:** the picked hex can be adjusted in the hex input; optional "Images unreliable" flag and a note. Enter saves (`POST /api/hex-labels-admin/labels`, with the image id and normalized sample point) and advances; S skips, N/→ and P/← navigate, U (or Ctrl/⌘+Z) undoes the last save (deletes a new label or restores the one it replaced). A warning shows when the sampled image has no public vendor URL (such labels are not exported to the eval fixture). The progress bar shows labeled / total for the current filters.
- Labels never change the shade's `vendor_hex` / `detected_hex`.

## Utilities (`src/lib/`)

| File | Exports |
|------|---------|
| `utils.ts` | `cn()` — Tailwind class merging (shadcn standard) |
| `constants.ts` | `FINISHES` (re-export of the shared built-in `CANONICAL_FINISHES` defaults), `finishLabel()`, `finishBadgeClassName()` — fallback finish taxonomy and branded badge styling when reference APIs are unavailable |
| `finish-options.ts` | `buildFinishOptions(finishTypes, extraValues?)`, `knownFinishNames()`, `resolveFinishLabel()` — finish select/chip options and labels built from ALL reference `finish_type` rows (including admin-added, non-built-in types), falling back to `FINISHES` only when reference data is empty; `extraValues` keeps a polish's saved finishes selectable when they are missing from the list |
| `admin-tabs.ts` | `ADMIN_TABS`, `AdminTab`, `getTabFromQuery()` (unknown/missing `?tab=` → `configuration`), `buildAdminTabSearch()` — `/admin` tab ↔ query-string mapping |
| `color-harmonies.ts` | Harmony palette generation + `getHarmonyTypeOptions()` for API-backed harmony option mapping (with fallback constants) |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB↔OKLCH conversions, `colorDistance()`, harmony helpers, undertone breakdown, and `analyzeCollectionGaps()`. The forward OKLAB math (`rgbToOklab`, `hexToOklab`, `oklabDistance`, `colorDistance`, `OKLab`) is re-exported from `swatchwatch-shared` so it matches the Functions API exactly |
| `api.ts` | API client helpers (plus the exported `API_BASE_URL`, `getAuthHeaders()` and `ApiError` with its HTTP `status`) including polish CRUD, `getCollectionStats()` (#271), private nail photos (`getNailPhoto`, `uploadNailPhoto`, `deleteNailPhoto`), rapid-add capture calls, ingestion admin methods (`listIngestionJobs`, `runIngestionJob`, `getIngestionJob`), reference-data admin methods (`listAdminJobs`, finish/harmony CRUD, finish-normalization CRUD; failures throw the exported `ApiError` with `status`, the server message and the parsed error `body`), user-management admin methods (`listAdminUsers`, `mergeAdminUsers`), hex-labeling admin methods (`getHexLabelQueue`, `getHexLabelShade`, `saveHexLabel`, `deleteHexLabel`), shade review-queue admin methods (`listShadeReviewQueue`, `getShadeReviewCandidates`, `approveShadeReview`, `mergeShadeReview`, `rejectShadeReview`), public reference lookup methods (`listReferenceFinishTypes`, `listReferenceHarmonyTypes`), `matchPolishesToImage()` for photo matching, mani-log CRUD (`listManicures`, `getManicure`, `createManicure`, `updateManicure` (PATCH), `deleteManicure`) and mani photos (`uploadManicurePhoto`, `deleteManicurePhoto`), the CSV import calls (`createPolishImport`, `getPolishImport`, `savePolishImportDecisions`, `commitPolishImport`, `deletePolishImport`), and the shareable-wishlist calls (`getWishlistShare()` → `null` when the server flag is off, `enableWishlistShare()`, `rotateWishlistShare()`, `revokeWishlistShare()`, and the credential-less `getPublicWishlist(token)`), the dupe finder calls `getPolishDupes(id, { limit? })` / `getPolishDupeHints(shadeIds)`, and `exportCollection(format, { status? })` for the collection export download |
| `hex-sampling.ts` | Pure helpers for the Hex Labeling tab: `averageRegion()` (average a `size`×`size` RGBA window → `#RRGGBB`, skipping fully transparent pixels, clamped at image edges), `clientToPixel()` (pointer → canvas pixel for a CSS-scaled canvas), `toSamplePoint()`, `normalizeHexInput()` (`#RRGGBB`/`RRGGBB`/`#RGB` → `#RRGGBB`), `readableTextColor()`, `hexLabelKeyAction()` (keyboard map), `stepSampleSize()`, `planUndo()` / `labelToRequest()` (delete a new label or restore the replaced one), `labelProgress()` |
| `wishlist-share.ts` | Shareable-wishlist helpers (#268): `readShareToken(searchParams)` (43-char base64url or null), `buildWishlistShareUrl(origin, path)`, `publicWishlistTitle()`, `publicWishlistErrorMessage(status)`, `wishlistSharePrivacyNote(visible, hidden)` |
| `private-image.ts` | `isPrivateImageUrl(url, apiOrigin?)` (true when the path starts with `/api/images/v3.` and the URL is relative or on the origin of `api.ts`'s `API_BASE_URL`; the same path on any other host is treated as public, so the bearer token is never sent there), `usePrivateImage(url)` → `{ status: "idle" \| "loading" \| "ready" \| "denied" \| "error", objectUrl }` — fetches private ids with `getAuthHeaders()` (dev-bypass token included), returns an object URL that is revoked on unmount or url change, and ignores stale responses via `AbortController`. Non-private URLs return `idle` so callers render the plain URL. `loadPrivateImage()` / `classifyPrivateImageResponse()` are the framework-agnostic pieces the hook uses |
| `outbound-link.ts` | `safeOutboundUrl(value)` (normalized URL only for absolute `http:`/`https:` URLs without credentials, whitespace or control characters; else null) and `outboundLinkProps(value)` → `{ href, target: "_blank", rel: "noopener noreferrer nofollow" }` or null. Client-side defense in depth for API `buyUrl` values, which the Functions API already validates |
| `color-family-filter.ts` | `parseColorFamilyParam()` (URL value → families in canonical order, unknown values dropped, `gray` → `grey`), `serializeColorFamilies()`, `toggleColorFamily()`, `colorFamilySwatchBackground()` — `/polishes` family-chip state helpers |
| `image-downscale.ts` | `downscaleImageFile()` — browser canvas downscale (longest edge `MATCH_IMAGE_MAX_EDGE` = 640px, JPEG for photos / PNG when the source may have alpha, or a forced `outputMimeType`) returning a data URL + dimensions; `computeScaledSize()` / `outputMimeTypeFor()` pure helpers; `decodeImage()` (EXIF-aware decode, also used by `frame-capture.ts`); `encodeScaledImage()` (canvas downscale + encode of an already-decoded image, used by the HEIC path) |
| `heic-convert.ts` | Browser HEIC/HEIF decoding (#318, decision D9): `looksLikeHeic()` (MIME type, or the `.heic`/`.heif`/`.hif` extension when the browser reports no type), `hasHeicSignature()` / `isHeicFile()` (ISO-BMFF `ftyp` brand sniff for untyped files; AVIF's `mif1`/`avif` are excluded), `decodeHeic()` → upright `ImageBitmap` via `heic-to` (libheif/WASM, ~3 MB, LGPL-3.0) loaded with a dynamic `import("heic-to/next")` on first use only (`loadHeicDecoder()`, retried after a failed load), `HeicConversionError` with user-facing messages |
| `nail-photo.ts` | Private photo upload helpers (nail photos #270, mani photos #327): `prepareNailPhotoUpload(file)` (validates, then re-encodes to JPEG ≤ `NAIL_PHOTO_MAX_EDGE` with the browser's decoder; HEIC/HEIF it cannot decode — everything but Safari — is converted with `decodeHeic()` and never sent as-is (#318); other API-accepted types within `NAIL_PHOTO_MAX_UPLOAD_BYTES` fall back to the original bytes when the browser cannot decode them; steps injectable via `NailPhotoPrepareDeps` for tests), `validateNailPhotoFile()` (accepts untyped HEIC), `canUploadOriginal()`, `describeNailPhotoError(status)`, `NAIL_PHOTO_INPUT_ACCEPT`. API calls: `getNailPhoto`, `uploadNailPhoto`, `deleteNailPhoto` in `api.ts` |
| `barcode-scan.ts` | `createBarcodeScanner()` → `{ engine: "native" \| "zxing", detect(source, { thorough? }) }`. Pure helpers: `selectBarcodeEngine()` (native `BarcodeDetector` only when it reads EAN-13 or UPC-A), `normalizeScannedBarcode()` / `pickBestBarcode()` (EAN-13 > UPC-A > EAN-8 > UPC-E, GS1 check digit validated, UPC-E via `expandUpcE()`), `hasValidGtinCheckDigit()` |
| `barcode-zxing.ts` | `createZxingDecoder({ tryHarder })` over a luminance buffer using `@zxing/library` (pinned `0.23.0`). Only reached through a dynamic `import()` from `barcode-scan.ts`, so zxing is a separate chunk downloaded only by browsers without a usable `BarcodeDetector` |
| `camera.ts` | `getCameraAvailability()`, `classifyCameraError()` + `CAMERA_ERROR_COPY`, `buildCameraConstraints("rear" \| "any")`, `shouldRetryWithoutConstraints()`, `rgbaToLuminance()`, `computeFrameQuality()` (brightness / contrast / Laplacian sharpness) and `assessFrameQuality()` warnings |
| `frame-capture.ts` | Browser-only: `captureFrameFromSource(video \| canvas \| bitmap)` and `captureFrameFromFile(file)` → JPEG data URL (longest edge 1600px), dimensions, quality metrics and the canvas for barcode detection |
| `rapid-add-flow.ts` | Rapid Add state: `framesReducer` (upload queue with retry), `sessionReducer` + `rapidAddPhase()` (collecting → question → resolving → verdict), `canFinalize()`, `buildStartMetadata()` (scanned GTIN goes in the session metadata), `buildFrameQuality()`, `buildQuestionView()` |
| `capture-verdict.ts` | `buildOwnershipSnapshot()` (owned rows loaded before finalize, because finalize adds the match), `deriveCaptureVerdict()` → `owned` / `added` / `add`, `resolveCaptureVerdict()` with the `VerdictResolver` extension point (`DEFAULT_VERDICT_RESOLVERS`, empty until near-dupe #265 / wishlist #261), metadata readers |
| `install-prompt.ts` | `detectInstallSurface()` (`installed` / `native-prompt` / `ios-hint` / `none`), `isIosDevice()`, `isInAppBrowser()`, `isInstallPromptSnoozed()` |
| `polish-filters.ts` | `buildBrandOptions()`, `filterPolishesForList()`, `matchesBrandFilter()` — shared catalog/search filter helpers with normalized brand matching. Ownership is `status === "owned"` and the `wishlist` availability filter is `status === "wishlist"` (catalog rows without inventory are neither) |
| `mani-log.ts` | Mani log helpers (#269): `toLocalIsoDate()`, `addDays()`, `startOfWeek()` (Monday), `calendarStripRange()` / `buildCalendarStrip()` (weeks of `CalendarDay` with the day's manicures and swatch hexes), `manicureHexes()` / `manicurePolishHex()`, `formatWornOn()` (Today / Yesterday / short date), `MANICURE_ROLE_LABELS`, form helpers (`ManiFormEntry`, `defaultRoleFor()`, `pickablePolishes()` = owned + destash, `filterPickable()`, `validateManiForm()`, `buildManicureRequest()`, photo draft `ManiPhotoDraft` / `initialManiPhotoDraft()` / `maniPhotoSaveAction()`), `quickLogRequest(polish, todayIso, companions?)` (companions append extra `{ id, role }` polishes, de-duplicated) and `canLogPolish()` (needs an inventory row) |
| `pick-for-me.ts` | "Pick for me" weighting (#272), pure and seedable: `createSeededRandom(seed)` (mulberry32), `scorePickCandidates(polishes, now)` (owned only; weight = tried × recency × gap with the documented `PICK_WEIGHTS`: untried ×3; never worn ×2, else ramps 1→2 over 90 days since `lastWornAt`, worn today/yesterday ×0; thin gap-heatmap cell (`analyzeCollectionGaps().underrepresented`) ×2), `pickForMe(polishes, { now, random, exclude })` (never repeats the last `PICK_HISTORY_SIZE` = 3 ids while anything else is owned; ignores the wear cooldown only when nothing else is left), `pushPickHistory()`, reason labels (`describeGapCell()`, `formatRestPeriod()`), and `suggestPairings(pick, polishes, max = 2)` — complementary / analogous owned polishes from `generateHarmonyPalette()` within OKLAB `PAIR_MAX_DISTANCE` (0.12, and closer to the target than to the pick; skipped for neutral picks) plus a topper/flake/glitter accent topper |
| `polish-import.ts` | CSV import wizard helpers (#263): `checkImportFile()` (size/type), `buildImportPreview()` (shared `parseCsv` + `detectPolishImportHeader`, same as the API), `importColumns()` (labels + sample values), `setColumnField()` / `fieldForColumn()` / `importMappingError()`, and review state: `tabCounts()`, `rowsForTab()`, `actionCounts()`, `setRowDecision()`, `acceptTopCandidates()`, `setActionForState()`, `pickSearchResult()`, `changedDecisions()` (only edited decisions are sent on commit), `decisionValue()` / `parseDecisionValue()` |
| `inventory-status.ts` | Inventory status helpers (#261): `isOwnedPolish()` (`status === "owned"`, the only ownership test the web app uses — never `quantity`), `quantityChangeUpdate(polish, delta)` (PUT body for the quantity stepper: adding a non-owned polish makes it `owned` with ≥ 1 bottle; removing the last bottle moves it to `archived` — used up is not the same as wanted, #262 / D5c), `isArchivingChange()`, `formStatusForSave(status, quantity)` (edit form: owned + 0 bottles → `archived`), the PUT bodies `archiveReasonUpdate(reason)`, `undoArchiveUpdate()`, `rebuyUpdate()` (archived → wishlist, the detail page's Rebuy) and `canRebuy()`, `POLISH_STATUS_LABELS` / `POLISH_STATUS_OPTIONS`, `formatPurchasePrice()`, `summarizeCollection(ownedRows, wishlistTotal)` (dashboard tiles: owned, untried, untried % of owned, wishlist) |
| `polish-list-url.ts` | `/polishes` URL state (#262): `parsePolishesListState()` / `buildPolishesListQueryString()` (canonical `q`, `status` (comma list), `untried`, `tone`, `finish`, `family` (color families, #103), `sort`, `dir`, `page`, `pageSize`; legacy `scope=collection`, `all=0` → `status=owned`, `availability`/`avail` → that status, never written back), `toApiFilters()` (sends only `status`/`untried` for ownership), preset helpers `statusPresetFor()` / `statusesForPreset()`, `toggleStatus()`, `hasActiveFilters()`, `statusFilterSummary()` |
| `collection-actions.ts` | Row actions + optimistic reducers (#262): `collectionActionRequest()` (PUT body or DELETE for `set-status` / `remove-from-wishlist` / `set-tried`; null for no-ops), `statusChangePatch()` (owned/destash keep ≥ 1 bottle; wishlist/archived leave `quantity` alone), `optimisticPolish()` / `applyInventoryPatch()` (recompute `isUntried`), and `applyOptimistic` / `commitOptimistic` / `rollbackOptimistic`, which only settle a row that still holds the request's optimistic object so an older response never overwrites a newer change. `statusChangeEvent()` builds the `collection.status_changed` telemetry properties |
| `dupes.ts` | Dupe finder client helpers (#265), pure so the add-guard (#266) and Rapid Add verdict card (#21) can reuse them: `fetchDupeHints(ids, getPolishDupeHints)` (chunks to `DUPE_LIMITS.batchMaxShadeIds` and merges), `dupeHintShadeIds(polishes)` (rows not owned), `chunkShadeIds()`, `dupeVerdict(hintOrResponse)` → `{ kind: "dupe-owned" \| "near-dupe-owned" \| "none", best }`, `dupeHintLabel()` / `dupeHintTitle()` / `dupeCalloutText()`, `dupeHref()`, `DUPE_GRADE_META` (badge label/classes per grade), `FINISH_COMPATIBILITY_LABELS` |
| `add-guard.ts` | Add guard (#266) decision logic, pure and unit-tested: `addGuardPrecheck()` (skip when the shade is already owned — that's a quantity increase —, already in the target status, suppressed this session, or a loaded batch hint says "no dupe"), `resolveAddGuard()` (one `loadDupes()` call, normally `getPolishDupes(id)`, raced against `ADD_GUARD_TIMEOUT_MS` = 2s; errors/timeouts → `proceed-unchecked`, never blocking the add), session suppression in `sessionStorage` (`readSuppressedGuardKeys` / `suppressGuardKey`, all behind try/catch, capped at 200 keys), `dupesForNewShade()` (client-side dupes for a not-yet-created shade from its hex/finishes and the owned rows, with the shared `findDupes` rule), `addGuardTelemetry()`, `wishlistInsteadUpdate()` |
| `hooks/use-add-guard.ts` | `useAddGuard()` → `{ guardAdd(request), active, choose, isChecking(key) }`: call `guardAdd` instead of adding directly (it calls `request.proceed(intent)` immediately when there is nothing to warn about), render `<AddGuardDialog guard={active} onChoice={choose} />`. Queues dialogs, ignores repeat clicks while a shade is being checked, and emits telemetry |
| `hooks/use-dupe-hints.ts` | `useDupeHints(polishes)` → `Record<shadeId, PolishDupeHint>` for the not-owned rows of a list, one batch request per page (errors swallowed; hints are optional) |
| `collection-export.ts` | Collection export download (#264): `buildCollectionExportUrl()`, `fetchCollectionExport(format, deps, options)` (fetch with auth headers → `{ blob, filename }`, throws `CollectionExportError` with the API message), `filenameFromContentDisposition()` (falls back to `collectionExportFilename()` from swatchwatch-shared), `saveBlobAsFile(blob, filename)` (temporary `<a download>` + object URL, revoked afterwards). Never a bare link: the bearer token must be sent |
| `collection-stats.ts` | Collection stats panel helpers (#271): `currencyKey()` / `currencyLabel()` (`null` = "No currency"), `currencyOptions()`, `findSpend()` / `findCostPerWear()`, `formatMoney()` (per currency, via `formatPurchasePrice`), `barPercent()` (min visible width for non-zero bars), `ringArc()`, `labelledMonths()`, `formatMonthShort()` / `formatMonthLong()` / `formatWornDate()` (UTC), `sharePercent()`, `statsDisplayHex()`, `isEmptyCollection()` |
| `hooks/use-reference-data.ts` | API-backed reference data hook with in-memory + localStorage caching, resilient fallback data, and lookup helpers (`getFinishDisplayName`, `getHarmonyDisplayName`) |
| `msal-config.ts` | `buildMsalConfig()` builder, `LOGIN_SCOPES` constant. Returns `null` if auth env is not configured |
| `auth-token.ts` | Module-level token store: `setAccessToken()`, `getAccessToken()` |
| `job-logs.ts` | Ingestion job log helpers for Admin Jobs: `getJobLogs(job)`, `summarizeJobLog()` (shown/total/omitted lines and run-wide error/warning counts, including lines rolled up in the omission marker), `formatJobLogCount()`, `filterJobLog(entries, "all" \| "problems")`, `isOmissionMarker()` |
| `metrics-events.ts` | M2 success-metric events (D19, #323): `dupe.warning_shown` / `dupe.warning_outcome` builders and `track*` helpers (`surface`, `dupeCount`, `bestGrade`, `outcome`), `mani.logged`, `import.completed` (skips an already-committed import). Counts and enum values only; goes through `trackEvent`, so a no-op without a connection string |
| `telemetry.ts` | Browser Application Insights wrapper mirroring the Functions API: `trackEvent()`, `trackException()`, `setUser(userId)`, `clearUser()`, `initTelemetry()`. Lazy `import()`s `@microsoft/applicationinsights-web` (own chunk, out of the critical bundle) and queues calls until it loads; no-op on the server and without a connection string. Config: auto route tracking, W3C correlation limited to the `NEXT_PUBLIC_API_URL` host, unhandled-rejection tracking, sampling. A telemetry initializer (`redactImageUrlsInitializer`) replaces `/api/images/{id}` ids, `/api/wishlist/{token}` tokens and `?token=` query values with `[redacted]` (`redactCapabilities()`) |

## Metadata & Assets

| Asset | Location | Notes |
|-------|----------|-------|
| Favicon (SVG) | `public/brand/swatchwatch-monogram.svg` | Referenced via metadata `icons` config |
| Apple Touch Icon | `public/apple-touch-icon.png` | 180x180 opaque PNG (iOS applies its own mask) generated from the app icon glyph |
| PWA icons | `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png` | PNG icons the manifest references (`purpose: any` 192/512, `maskable` 512 with the glyph inside the safe zone); Chromium needs raster icons of these sizes before it fires `beforeinstallprompt`. Regenerate with `npm run generate:pwa-icons` (`scripts/generate-pwa-icons.mjs`, uses `sharp` already installed for `packages/functions`) after changing `public/brand/swatchwatch-app-icon.svg`, and commit the PNGs |
| OG Image | `public/og-image.png` | 1200x630 branded social preview |
| OG Variants | `src/app/(app)/dashboard/opengraph-image.tsx`, `src/app/(app)/polishes/opengraph-image.tsx` | Route-specific social previews for dashboard and collection |
| Manifest | `public/manifest.json` | PWA manifest with brand colors, PNG + maskable + SVG icons and a "Rapid Add" app shortcut; `<InstallPrompt />` offers installing it on mobile web |
| Brand SVGs | `public/brand/` | Monogram, wordmark, lockup, swatch, brush, app icon, sprite sheet |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | API base URL used by `src/lib/api.ts` |
| `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` | Enables browser telemetry (`src/lib/telemetry.ts`). Unset = no-op (local dev default). Set at build time by `deploy.yml` from the Terraform output `application_insights_connection_string` |
| `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` | Browser telemetry sampling percentage, `(0, 100]`; default `100` |
| `NEXT_PUBLIC_AUTH_DEV_BYPASS` | Dev-only bypass toggle. When `true`, the UI sends `Authorization: Bearer dev:1` on authenticated API calls. Set to `false` for production or to test B2C auth locally |
| `NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID` | Optional admin dev bypass user id for admin-only API calls (`/admin/reference-data` and `/admin/jobs` flows; defaults to `2`). Ignored when `NEXT_PUBLIC_AUTH_DEV_BYPASS=false` |
| `NEXT_PUBLIC_B2C_TENANT` | Entra tenant short name (e.g., `myorgdev`). Empty or missing → auth skipped, unconfigured fallback mode. When set with `NEXT_PUBLIC_B2C_CLIENT_ID` → MSAL initialized |
| `NEXT_PUBLIC_B2C_TENANT_ID` | Entra External ID (CIAM) tenant GUID. Required for CIAM tenants: the MSAL authority becomes `https://<tenant>.ciamlogin.com/<tenant-id>` so the metadata issuer (`https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`) passes msal-browser 5.x issuer validation. When omitted for a CIAM policy, MSAL is not initialized and the app uses unconfigured-auth mode. Unused for legacy `B2C_1*` policies |
| `NEXT_PUBLIC_B2C_CLIENT_ID` | Entra app registration client ID. Must be set alongside `NEXT_PUBLIC_B2C_TENANT` to enable auth |
| `NEXT_PUBLIC_B2C_API_SCOPE` | Optional API scope(s) for access tokens (space-delimited). Defaults to `api://<NEXT_PUBLIC_B2C_CLIENT_ID>/access_as_user` when unset |
| `NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY` | Policy/user-flow selector. If it starts with `B2C_1`, the app uses legacy `b2clogin.com` policy authority. Otherwise it uses `ciamlogin.com` authority and sends `p=<value>` query parameter on auth/token requests (for External ID tenants). |

**Note:** When both `NEXT_PUBLIC_B2C_TENANT` and `NEXT_PUBLIC_B2C_CLIENT_ID` are empty, the app runs in **unconfigured mode**: marketing pages work, but `(app)` routes show a "Sign in" prompt that warns the user B2C is not configured.

## Telemetry & Error Boundaries

Browser telemetry goes to the same Application Insights resource as the Functions API (plan: `docs/observability-plan.md`).

- **Off by default.** `src/lib/telemetry.ts` does nothing unless `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` is set at build time. To try it locally, put the dev connection string in `apps/web/.env.local` and restart `next dev`.
- **What's collected:** page views (initial + App Router `pushState` navigations), unhandled errors and promise rejections, `fetch` dependencies, and anything sent through `trackEvent` / `trackException`. Requests to the `NEXT_PUBLIC_API_URL` host carry a W3C `traceparent`, so a browser fetch and the Functions request it hits share one `operation_Id` in **Transaction search**. No other origin gets correlation headers (B2C and blob storage would reject them on preflight).
- **Privacy:** telemetry carries the internal user id only (never the email), and capabilities are redacted: `/api/images/{id}` ids plus shared-wishlist tokens (`/api/wishlist/{token}` and the `/w/?token=` page URL). The SDK sets its default `ai_user` / `ai_session` cookies; whether to keep them (or set `disableCookiesUsage: true` in `buildTelemetryConfig`) is an open decision.
- **Collection events (#262):** `collection.status_changed` (`from`, `to` — `none` for a catalog-only row — and `via`: `quick-action`, `menu` or `stepper`) and `collection.tried_changed` (`tried`, `via`) after a successful row update on `/polishes`; `collection.summary` (`owned`, `untried`, `untriedPercent`, `wishlist`) on each dashboard load, for the Sprint 1 status-adoption metrics.
- **M2 metric events (D19, #323):** built in `src/lib/metrics-events.ts` (counts and enum values only, unit-tested). `dupe.warning_shown` when the add guard dialog opens (`surface` = `add_form` / `wishlist` / `rapid_add`, `dupeCount`, `bestGrade` = `HIGH` / `MEDIUM`, plus `page`, `intent`, `shade`, `verdict`, `highCount`, best dupe finish compatibility/distance); `dupe.warning_outcome` when it is answered (same plus `outcome` = `cancel` / `wishlist_instead` / `add_anyway`, `via` = `button` / `dismiss` / `dupe_link`, `suppressed`); `mani.logged` for a new mani (`polishCount`, `via` = `quick` / `form`); `import.completed` on a CSV import commit (`rowsCommitted`, `created`, `updated`, `skipped`, `failed`, `shadesCreated`). `rapid_add` is reserved until the Rapid Add verdict card shows near-dupes. Funnel KQL and the weekly DB query: `docs/observability-plan.md` ("M2 success metrics"). Roadmap metric: share of `dupe.warning_shown` ending in `cancel` or `wishlist_instead` (target > 20%).
- **Add guard events (#266):** `add_guard.check_failed` (`reason` = `error` / `timeout`; the add went ahead unchecked). The dialog's shown/answered events are the `dupe.*` events above (they replaced `add_guard.shown` / `add_guard.choice`).
- **Error boundaries:** `(app)/error.tsx` and `(admin)/error.tsx` report via `trackException` and show `ErrorState` with a retry (`reset()` re-renders the segment; the pages fetch client-side, so that refetches too). `app/global-error.tsx` catches root-layout failures. They're all client components, so they work with `output: "export"`.

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `swatchwatch-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.
