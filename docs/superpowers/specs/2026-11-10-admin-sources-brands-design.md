# Admin Sources tab: sites, brands and store permission — design

Status: design agreed with the owner in brainstorming on 2026-11-10/11 (mockup:
`.superpowers/brainstorm/…/content/sources-tab.html`, not committed). Calls marked **(builder's
call)** or **(my call)** were not discussed with the owner and can be revisited.

Owner approved the design on 2026-11-11, including the builder's-check calls. Owner decisions on 2026-11-11: **Turn on is never blocked** (the owner turns stores on at will;
without an OK on record it asks for a confirmation and the audit row says so), and **Mooncat and
Cupcake Polish have an OK on record** (the migration records them as granted).

## Why

SwatchWatch now ingests from about 50 data sources: brand stores, multi-brand retailers and feeds
(the brand-sources batch, PRs #502–#506). About 20 of them are waiting on the store's written OK,
and the owner tracks who was emailed and who said yes **only in personal notes**. Today, enabling a
store means editing `SHOPIFY_SOURCES_PENDING_APPROVAL`, the seed file and writing a migration. Nothing
shows which brands have a source and which don't, or why (ILNP: custom Laravel site with no feed;
KBShimmer: WooCommerce behind Cloudflare that answers 403 to automated requests; I Scream Nails: no
official store, carried by Beyond Polish and Sleek Nail).

The tab replaces the notes and the code-plus-migration routine. When a store answers "yes", the
owner opens its row, records the OK, the store turns on, and they press Run.

## Goals

1. One admin tab, `/admin?tab=sources`, with a **Sites / Brands** switch; each view is a
   filterable, sortable table with its state in the URL like the other admin tabs.
2. **Sites:** one row per `data_source` with its permission status, editable from the tab:
   record "asked", record an OK (who, date, how, what they agreed to, images yes/no), record a
   decline, turn the store on or off, run one ingestion job.
3. **Brands:** one row per `brand`, including brands with **zero shades**: the owner is preparing a
   connector for every brand, so a brand can be added from the tab before anything is ingested. Each
   brand has a small editable profile (website, platform, blocker/plan note, its own store).
4. Every write is audit-logged (`admin_audit_event`) in the same transaction.

## Non-goals

- Creating a `data_source` from the UI. A new source still needs connector code (store filter,
  title parser, registry entry) and a migration; this tab manages the rows that exist.
- Editing other source settings (`vendorAliases`, `includeGel`, `maxPages`, connector keys). The
  existing `PATCH /api/ingestion/sources/{id}/settings` and Admin Jobs stay as they are.
- The full job options form. Run here starts one job with the Admin Jobs defaults; anything
  fancier is done on Admin Jobs.
- Deleting or merging brands, editing brand aliases.
- Sending the permission emails.

## Anti-goals (would make this a failure even if it works)

- A store with an automated-access clause in its terms gets switched on with no OK on record
  **without anyone noticing** (decision D2). The owner may turn any store on, but the tab makes
  recording the OK the easy path, asks before turning on without one, shows the "On, no OK
  recorded" warning afterwards, and the audit row records the override.
- A permission status that silently disagrees with what the job actually does (e.g. "images
  allowed" recorded but `metadata.imagesPermitted` still false).
- A brand added here leaking into user-facing catalog surfaces as if it had polishes.

## Current state the design builds on

- `data_source(enabled, metadata jsonb)`. `metadata.kind` is `brand` (absent), `retailer` or `feed`
  (`lib/source-settings.ts`: `sourceKindFromMetadata`, `sourceKindSql`). `metadata.imagesPermitted`
  (default true only for brand sources). `metadata.pendingApproval: true` on rows registered
  disabled. `metadata.notes` free text; many rows also carry `metadata.verification`
  (`termsScrapingClause`, `writtenPermission`, `checkedAt`, …).
- `SHOPIFY_SOURCES_PENDING_APPROVAL` / `CONNECTOR_SOURCES_PENDING_APPROVAL` only decide the
  `enabled` value of a row that is **auto-provisioned** (`createDataSourceIfMissing`, `ON CONFLICT
  DO NOTHING`). Once the row exists, only the database decides. The run endpoints refuse a disabled
  source (409 `source_disabled`). So recording an OK and turning a source on needs no deploy.
- `ingestion_job(data_source_id, status, started_at, finished_at, metrics_json)`;
  `external_product(data_source_id, missing_since)`; `shade_source_product(shade_id,
  external_product_id)`; `shade(brand_id, product_category, status, merged_into_shade_id)`;
  `brand(brand_id, name_canonical UNIQUE)`, `brand_alias`.
- `recordAdminAuditEvent` in `lib/admin-users.ts`; `admin_audit_event.action` is CHECK-constrained.

## Sites view

### Columns

| Column | Source |
|---|---|
| Site | `name` (display label: the source name with the connector suffix split off, e.g. `HypnoticPolishShopify` → "Hypnotic Polish", **builder's call** on the exact rule; the raw name is shown in the panel) and `base_url` host |
| Kind | `sourceKindFromMetadata`: Brand store / Retailer / Feed |
| Connector | protocol the registry dispatches to (Shopify, WooCommerce, Big Cartel, Product feed, Sitemap + JSON-LD, OpenBeautyFacts, …); `source_type` as fallback |
| On | `enabled` |
| Permission | status chip (below); "no images" hint when granted without images; a warning chip **"On, no OK recorded"** when the store is on, its terms have a clause and no OK is recorded |
| Last job | latest `ingestion_job`: status icon, relative time, records processed from `metrics_json` |
| Listings | live `external_product` rows (`missing_since IS NULL`) |
| Shades | distinct unmerged shades reached through `shade_source_product` |

Default sort: Site ascending. Sortable on every column.

### Filters (all in the URL)

`view=sites`, `kind=brand|retailer|feed`, `enabled=on|off`, `permission=` (comma list of the
statuses below), `q=` (name or URL substring), `sort=`, `dir=`, `open=<dataSourceId>` (the open
side panel). Absent = no filter.

### Permission status

Stored as `data_source.metadata.permission` (my call: jsonb, no new table; the history lives in
`admin_audit_event`):

```ts
type SourcePermissionStatus = "not_needed" | "not_asked" | "asked" | "granted" | "declined";
interface SourcePermission {
  status: SourcePermissionStatus;
  askedAt?: string;          // YYYY-MM-DD the owner emailed
  decidedAt?: string;        // YYYY-MM-DD of the answer
  grantedBy?: string;        // "Anna, owner"
  channel?: string;          // email | DM | form | phone | other
  summary?: string;          // what they agreed to / why they declined
  imagesGranted?: boolean;   // granted only
  recordedByUserId?: number; recordedAt?: string;
}
```

When `metadata.permission` is absent the status is **derived** (no migration rewrites rows):

1. `verification.writtenPermission` set → `granted` (images granted = current `imagesPermitted`).
2. Else `verification.termsScrapingClause === false` → `not_needed`.
3. Else `pendingApproval === true` → `not_asked`.
4. Else (`enabled` with a clause or unknown terms) → `not_asked`, which with `enabled = true`
   shows the "On, no OK recorded" warning. (Mooncat and Cupcake Polish no longer land here: the
   migration stores `permission = { status: "granted", summary: "OK on record in the owner's
   notes (recorded 2026-11-11)", imagesGranted: <current imagesPermitted> }` on
   `MooncatShopify` and `CupcakePolishShopify`, so they never show the warning.)
5. Internal sources that are not stores (`Manual`, user captures, CosIng, …; anything whose
   connector is not a store fetch) → `not_needed` (**builder's call** on how to recognise them; the
   registry knows which sources are fetchable).

The derivation is a pure function in `packages/shared` (`deriveSourcePermission(metadata,
enabled)`), unit tested, used by the API so the client never re-derives.

### Side panel (opens on row click, `open=` in the URL)

Shows the raw source name, kind, connector, currency, base URL (link), terms finding
(`verification.termsScrapingClause`, `checkedAt`), `metadata.notes` (collapsed), the permission
form, the action buttons and the history (audit events for this source, newest first).

Actions and what each writes, each in one transaction with one audit event:

| Action | Writes |
|---|---|
| **Mark asked** (date, default today) | `permission = { status: "asked", askedAt }` |
| **Record OK & turn on** (who, date, channel, summary, ☑ images allowed) | `permission = { status: "granted", … imagesGranted }`; `enabled = true`; removes `pendingApproval`; `imagesPermitted = imagesGranted`; appends one sentence to `metadata.notes` ("Acceptable use confirmed by … on … via …: …", the format `docs/indie-sources-2026-10.md` already uses) |
| **Record decline** (date, channel, note) | `permission = { status: "declined", … }`; `enabled = false` |
| **Turn on** | `enabled = true`, removes `pendingApproval`. Always allowed (owner decision). When the status is not `granted`/`not_needed` the panel asks first ("No OK on record for X. Turn on anyway?", or "X declined on <date>. Turn on anyway?") and the request must carry `override: true`, else 409 `permission_required`; the audit row stores `override: true` and the status at that moment. Permission is not changed |
| **Turn off** | `enabled = false`. The confirmation says that the store's listings stop counting for buy links and prices (a disabled source is skipped by `selectBuyFromBrandLink`) until it is turned on again; shades and images stay |
| **Images allowed** toggle (granted only) | `imagesPermitted` and `permission.imagesGranted` together |
| **Run ingestion** (on only) | `POST /api/ingestion/jobs` for this source with the Admin Jobs form defaults for its connector (**builder's call**: read them from the Admin Jobs page and share one constant, per connector where Admin Jobs differs); the row's Last job polls until the job leaves `queued`/`running` |

**Blocked sources** (owner decision 2026-11-11): the tab has no blocked state, chip or Clear
block action. `metadata.blocked` (ILNP, KBShimmer) is left alone and will be revisited once
anti-bot options are explored. If Run is pressed on such a row, the existing run guard answers
409 `source_blocked` and the panel shows that message like any other run error.

**Status transitions** (my call): any status can be recorded from any other. Recording a decline
turns the store off; re-asking after a decline is just **Mark asked** again; a grant can be revoked
by recording a decline. Permission and on/off stay independent apart from Record OK (turns on) and
Record decline (turns off).

**Non-store sources** (`Manual`, user captures, CosIng and any other row with no fetching connector,
recognised from the connector registry: no entry in `SOURCE_PROTOCOL_MAP` / `CONNECTOR_FACTORIES`)
are listed read-only: permission `not_needed`, no on/off, no Run, no permission form (my call).

The "images allowed" checkbox defaults to checked for a brand store and unchecked for a retailer or
feed, matching the `imagesPermitted` defaults. Editing the fields of an existing grant (typo fixes)
is allowed and audited.

## Brands view

### Columns

| Column | Source |
|---|---|
| Brand | `brand.name_canonical` |
| Shades | catalog shades (`status = 'active'`, unmerged, not `user_submitted`; **builder's call** to confirm the visible-catalog predicate, reuse the one catalog search uses) split **color / other** by `product_category` |
| Own store | the brand's own `data_source` with its on/permission chip, or "none" |
| Retailers | retailer and feed sources with live listings on this brand's shades, as chips |
| Blocker / plan | `brand_ingest_profile.blocker` |
| Latest ingest | most recent `shade_source_product.last_seen_at` over the brand's shades |

**Own store** (my call): the union of (a) the explicit link `brand_ingest_profile.own_data_source_id`,
(b) a brand-kind source whose `metadata.brand` names this brand (case-insensitive, same match as
below; how the WooCommerce and Big Cartel rows already say whose store they are), and (c) a
brand-kind source with live listings on this brand's shades. All are shown, each with its on and
permission chips; the explicit one first. A store counts as "own" whatever its state (pending,
off), so Dazzle Dry with a pending store and zero shades shows as **Own store**, and the
filter answers "who has a store we could run", not "who is being ingested today".

**Supplied by** filter (`supply=`): `own` (has an own store), `retailer` (retailers only, no own
store), `both`, `none` (neither). Other URL params: `view=brands`, `q=`, `sort=`, `dir=`,
`open=<brandId>`.

### Brand profile (new table)

```sql
CREATE TABLE brand_ingest_profile (
  brand_id BIGINT PRIMARY KEY REFERENCES brand(brand_id) ON DELETE CASCADE,
  website_url TEXT,                -- http(s) only, validated
  platform TEXT,                   -- CHECK: shopify | woocommerce | bigcartel | custom | feed | none | unknown
  blocker TEXT,                    -- "Custom site (Laravel), no feed", "Cloudflare blocks automated access", "No official store"
  notes TEXT,
  own_data_source_id BIGINT REFERENCES data_source(data_source_id) ON DELETE SET NULL,
  updated_by_user_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The panel offers the three known blockers as quick picks plus free text. The migration seeds
profiles for ILNP, KBShimmer and I Scream Nails with the reasons above, creating the brand row
when missing (`ON CONFLICT DO NOTHING` on `name_canonical`).

### Add brand

**+ Add brand** creates a `brand` row (name, trimmed; 409 `brand_exists` with the existing brand
id when `lower(name_canonical)` or a `brand_alias` equals the name lower-cased, the same match
ingestion uses to resolve a vendor to a brand, so a brand added here is the one ingestion later
finds) plus its profile, audited. A zero-shade
brand appears in no user-facing list (those are built from shades). It does become resolvable by
the bottle flow's brand resolver (`brand-resolve.ts` reads `brand`), which is wanted: a bottle of
that brand then gets the brand right and the create card. (Builder: confirm no other user surface
lists `brand` rows without shades.)

## API (all `withAdmin`, `withCors`, `OPTIONS` listed; `/add-endpoint`)

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/sources-admin` | every `data_source` (enabled or not) with kind, connector, enabled, derived/stored permission, verification summary, last job, listing and shade counts |
| GET | `/api/sources-admin/{id}` | one source with notes and audit history |
| PUT | `/api/sources-admin/{id}/permission` | body = the action (`asked` / `granted` / `declined` / edit) and its fields; applies the writes above |
| PUT | `/api/sources-admin/{id}/enabled` | `{ enabled, override? }`; 409 `permission_required` when turning on a source whose status is not `granted`/`not_needed` without `override: true`; 409 `not_fetchable` for a non-store source |
| GET | `/api/brands-admin` | every brand with counts, own store, retailers, profile, latest ingest |
| POST | `/api/brands-admin` | create a brand (+ profile) |
| PUT | `/api/brands-admin/{id}/profile` | upsert the profile |

Run uses the existing `POST /api/ingestion/jobs`. Lists return all rows (about 50 sources and a few
hundred brands); filtering and sorting happen client-side from the URL state (my call). Shared
request/response types go in `packages/shared/src/types/sources-admin.ts`, re-exported. New audit
actions extend the `admin_audit_event_action_check` constraint in the migration:
`data_source.permission`, `data_source.enable`, `data_source.disable`, `data_source.images`,
`brand.create`, `brand.profile_update` (`target_user_id` NULL, ids and before/after in `changes`).

## Web

- `apps/web/src/app/(admin)/admin/reference-data/components/sources-tab.tsx` (+ a sites table, a
  brands table and the two side panels as separate components), registered in the admin page's
  tab list as "Sources".
- URL state in `apps/web/src/lib/sources-admin-url.ts` (parse/serialize, unit tested like
  `polish-list-url.ts`).
- API client functions in `apps/web/src/lib/api.ts`.
- shadcn primitives already in the repo (Table, Sheet or side panel, Badge, Button, Input, Select,
  Checkbox); no new dependencies.

## Docs (CLAUDE.md Documentation Maintenance)

CLAUDE.md routes table (`/admin` row gains the Sources tab) and the Connector ingestion paragraph
(enabling = record the OK in the Sources tab); `apps/web/README.md` (route + components);
`packages/functions/README.md` (route table; "Enabling a pending store" rewritten to the tab, with
the code-list cleanup as optional hygiene for fresh databases); `packages/shared/README.md` (new
types); `docs/schema.sql` (table + CHECK).

## Testing

- Unit: `deriveSourcePermission` cases (written permission, clause false, pending, enabled with
  clause, internal source, stored permission wins); permission action planning (which metadata keys
  change, enable guard with and without `override`);
  brand supply classification; URL parse/serialize round trip.
- Functions unit tests for the handlers with the fake-client pattern the repo uses (admin only,
  409s, audit row in the same transaction, `imagesPermitted` kept in step with `imagesGranted`).
- Browser check with dev bypass: filters and sort survive a reload, record an OK on a pending
  source turns it on, Run starts a job, add a zero-shade brand and link its store.

## Left to the builder

The display-name rule, how internal sources are recognised, the Admin Jobs defaults constant, the
visible-catalog predicate for shade counts, component split, and the exact query shapes.
