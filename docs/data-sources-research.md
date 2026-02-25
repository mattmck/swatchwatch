# Nail Polish Data Sources — Research & Integration Guide

> **Version:** 1.1 · **Date:** 2026-02-11 · **Companion to:** `implementation-guide.md`, `seed_data_sources.sql`

This document catalogs external data sources for populating the nail polish knowledge graph.
It covers what data each source provides, how to access it, practical limits, and how each
maps to the canonical schema (brand → product_line → shade → sku → label/ingredient).

---

## Table of Contents

1. [Source Comparison Matrix](#1-source-comparison-matrix)
2. [Public APIs (Free, No Auth)](#2-public-apis)
   - 2.1 Makeup API (Herokuapp)
   - 2.2 Open Beauty Facts
   - 2.3 EU CosIng
   - 2.4 Holo Taco Shopify Storefront
3. [Barcode / UPC Lookup APIs](#3-barcode--upc-lookup-apis)
   - 3.1 UPCitemdb
   - 3.2 Barcode Lookup
   - 3.3 Go-UPC
4. [Ingredient & Safety Databases](#4-ingredient--safety-databases)
   - 4.1 EWG Skin Deep
   - 4.2 INCIDecoder
   - 4.3 CosDNA
   - 4.4 CIR (Cosmetic Ingredient Review)
5. [Retail & Affiliate Data](#5-retail--affiliate-data)
6. [Community & Editorial Sites](#6-community--editorial-sites)
7. [Regulatory Databases](#7-regulatory-databases)
8. [Nail Polish Ingredient Reference](#8-nail-polish-ingredient-reference)
   - 8.1 Typical Formula Composition
   - 8.2 Common Ingredients by Function
   - 8.3 "Free-From" Tier Definitions
   - 8.4 Canonical Excluded-Ingredients Table
9. [Recommended Integration Strategy](#9-recommended-integration-strategy)
10. [Holo Taco Ingestion Options (Decision Record)](#10-holo-taco-ingestion-options-decision-record)

---

## 1. Source Comparison Matrix

| Source | Products | API? | Auth? | Color/Hex | Ingredients | Price | Barcode | Freshness | Free Tier |
|--------|----------|------|-------|-----------|-------------|-------|---------|-----------|-----------|
| **Makeup API** | 48 polishes | REST | None | ✅ hex + name | ❌ | ✅ (inconsistent) | ❌ | Stale (2016-18) | Unlimited |
| **Open Beauty Facts** | ~109 polishes | REST | None | ❌ | ❌ (field empty) | ❌ | ✅ | Stale | Unlimited |
| **EU CosIng** | 15,000+ ingredients | Bulk CSV | None | N/A | ✅ (reference) | N/A | N/A | Current | Open data |
| **Holo Taco Shopify** | 341 nail-polish products (310 singles) | REST | None | ⚠️ (derived only; no explicit hex) | ❌ | ✅ | ✅ (variant barcode) | Current | Storefront API |
| **UPCitemdb** | Millions (general) | REST | API key | ❌ | ❌ | ✅ (range + offers) | ✅ | Current | 100/day |
| **Barcode Lookup** | Millions (general) | REST | API key | ❌ | ❌ | ✅ | ✅ | Current | 100/day |
| **EWG Skin Deep** | ~4,000-5,700 polishes | ❌ | N/A | ❌ | ✅ (full + scores) | ❌ | ❌ | Updated Feb 2025 | N/A |
| **Temptalia** | 80,000+ swatches (all makeup) | ❌ | N/A | ✅ (swatch photos) | ❌ | ✅ | ❌ | Current | N/A |
| **Lacquer Tracker** | 17,000+ shades | ❌ | N/A | ✅ (community swatches) | ❌ | ❌ | ❌ | Current | N/A |

---

## 2. Public APIs

### 2.1 Makeup API (Herokuapp)

| | |
|---|---|
| **URL** | `https://makeup-api.herokuapp.com/api/v1/products.json` |
| **Auth** | None |
| **Rate limits** | None documented |
| **License** | Open / free |
| **Nail polish endpoint** | `?product_type=nail_polish` |

**What you get:** 48 nail polish products across 21 brands (dior, essie, orly, butter london,
china glaze, revlon, maybelline, wet n wild, pacifica, etc.). Each product has brand, name,
price, description, image URL, product link, and — critically — a `product_colors` array
with hex values and shade names.

**Sample response (trimmed):**
```json
{
  "id": 740,
  "brand": "dior",
  "name": "Junon",
  "price": "20.0",
  "price_sign": "£",
  "currency": "GBP",
  "description": "Discover the new-generation Dior Vernis...",
  "product_type": "nail_polish",
  "product_colors": [
    { "hex_value": "#FCD9CB", "colour_name": "108 Muguet" },
    { "hex_value": "#617686", "colour_name": "494 Junon" }
  ]
}
```

**Key fields:**

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | API internal ID |
| `brand` | string | Lowercase brand name |
| `name` | string | Product line or shade name |
| `price` | string | Numeric string, mixed currencies |
| `price_sign` / `currency` | string | Often null |
| `image_link` | string | Many are broken (old CDN paths) |
| `product_link` | string | Link to brand/retailer page |
| `description` | string | Marketing copy |
| `rating` | number \| null | 1.5-5.0 range when present |
| `tag_list` | string[] | Often empty; sometimes "Vegan", "Natural" |
| `product_colors` | array | **Most valuable field** — hex + shade name |

**Brands with most color data:** Essie (60 colors on one product), Butter London, China Glaze.

**Mapping to canonical schema:**

| API field | Schema table.column |
|-----------|-------------------|
| `brand` | `brand.name` |
| `name` | `product_line.name` or `shade.name` (needs parsing) |
| `product_colors[].colour_name` | `shade.shade_name_canonical` |
| `product_colors[].hex_value` | `color_features.dominant_hex` |
| `price` | `sku.price_hint` |
| `product_link` | `sku.product_url` |

**Assessment:** Best used as a **one-time seed** for the color reference database. The hex + shade
name pairs are directly useful for OKLAB matching. Too small and stale for ongoing catalog use.

---

### 2.2 Open Beauty Facts

| | |
|---|---|
| **URL** | `https://world.openbeautyfacts.org` |
| **API docs** | `https://world.openbeautyfacts.org/data` |
| **Auth** | None |
| **Rate limits** | None documented (respectful usage expected) |
| **License** | Open Database License (ODbL) |

**Search endpoint:**
```
GET /cgi/search.pl?search_terms=nail+polish&action=process&json=1&page_size=20
```

**Barcode lookup:**
```
GET /api/v2/product/{barcode}.json
```

**What you get:** ~109 nail polish products. Fields include barcode (`code`), `product_name`,
`brands`, `categories_tags`, and image URLs. The `ingredients_text` field exists but is
**consistently empty** across nail polish products — data quality tags show
`"en:ingredients-to-be-completed"`.

**Assessment:** Useful only for barcode → product name resolution when a user scans a bottle.
The ingredients gap is a dealbreaker for any ingredient-aware features. The project's
`seed_data_sources.sql` already lists this source. Bulk CSV exports are available for
bootstrapping.

---

### 2.3 EU CosIng (Cosmetic Ingredient Database)

| | |
|---|---|
| **URL** | `https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en` |
| **Bulk CSV** | Available via EU Open Data Portal and Kaggle mirror |
| **API** | No official REST API; Apitalks offers a free third-party wrapper (requires signup) |
| **License** | EU open data |

**What you get:** 15,000+ cosmetic ingredient entries with:

| Field | Description |
|-------|-------------|
| INCI Name | International Nomenclature of Cosmetic Ingredients |
| INN Name | International Nonproprietary Name |
| Chemical/IUPAC Name | Full chemical name |
| CAS Number | Chemical Abstracts Service registry number |
| EC Number | EINECS/ELINCS European inventory number |
| Function(s) | Assigned cosmetic functions (SOLVENT, FILM FORMING, PLASTICISER, etc.) |
| Restriction | Regulatory restrictions if any |
| Annex/Entry Number | Reference to Cosmetics Regulation annexes |

**Bulk download options:**
- Archived CSV: `COSING_Ingredients-Fragrance Inventory_v2.csv` via Wayback Machine
- Kaggle mirror: `kaggle.com/datasets/abdelrahmanashraf/cosmetic-ingredient-database` (1.3 MB)
- EU Open Data Portal: `data.europa.eu` dataset catalog

**Mapping to canonical schema:**

| CosIng field | Schema table.column |
|-------------|-------------------|
| INCI Name | `ingredient.inci_name` |
| CAS Number | `ingredient.cas_number` |
| Function(s) | `ingredient.function` |
| Restriction | `ingredient.regulatory_notes` |

**Assessment:** Import the full CSV as the `ingredient` reference table. This gives every
ingredient a normalized INCI name, CAS number, and functional classification. When users
or scrapers provide ingredient lists, match against this table to normalize names.

---

### 2.4 Holo Taco Shopify Storefront

| | |
|---|---|
| **URL** | `https://www.holotaco.com/products.json` |
| **Auth** | None |
| **Rate limits** | No documented public limit (still use respectful polling/caching) |
| **License/Terms** | Storefront terms apply; use as source metadata, not image redistribution |

**Endpoint patterns:**
```http
GET /products.json?limit=250&page=1
GET /products/{handle}.js
```

**Observed snapshot (queried on February 11, 2026):**
- 427 total storefront products
- 341 `product_type = "Nail Polish"` products
- 310 nail-polish singles (`bundle:product` excluded)
- 31 nail-polish bundles

**What you get well:**
- Current product cadence (recent launches visible quickly via `published_at`)
- Product/variant metadata: `title`, `handle`, `tags`, `variants[].sku`, `variants[].barcode`, price/availability
- Product images (`images[]`)

**What is missing/weak:**
- No explicit hex color field
- No ingredient list
- Bundle products require filtering to avoid duplicate shade-like entries

**Assessment:** Best current source for **recent Holo Taco catalog ingestion**. Use tags + titles
for searchable fields, and treat hex as optional derived data (from image pipeline) rather
than source-of-truth.

---

## 3. Barcode / UPC Lookup APIs

### 3.1 UPCitemdb

| | |
|---|---|
| **URL** | `https://api.upcitemdb.com/prod` |
| **Auth** | API key via `user_key` header (free tier: IP-based, no key needed) |
| **License** | Commercial, tiered pricing |

**Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/lookup?upc={code}` | GET/POST | Lookup by UPC/EAN/ISBN |
| `/v1/search?s={query}` | GET/POST | Search by keyword, brand, category |

**Search parameters:** `s` (keywords), `brand`, `category`, `title`, `model`, `offset`, `match_mode`, `type`

**Response structure:**
```json
{
  "code": "OK",
  "total": 1,
  "items": [{
    "ean": "0012345678905",
    "upc": "012345678905",
    "title": "OPI Nail Lacquer Big Apple Red",
    "brand": "OPI",
    "description": "Product description...",
    "dimension": "3.0 x 2.0 x 5.0 inches",
    "weight": "0.5 oz",
    "lowest_recorded_price": 5.99,
    "highest_recorded_price": 12.99,
    "images": ["https://..."],
    "offers": [{
      "merchant": "Amazon",
      "domain": "amazon.com",
      "list_price": 9.99,
      "price": 7.99,
      "condition": "New",
      "availability": "In Stock",
      "link": "https://amazon.com/..."
    }]
  }]
}
```

**Pricing tiers:**

| Plan | Cost | Lookups/day | Searches/day | Burst Limit |
|------|------|-------------|--------------|-------------|
| Explorer (Free) | $0 | 100 combined | (included) | 6/min |
| Dev | $99/mo | 20,000 | 2,000 | 15 lookups + 5 searches / 30s |
| Pro | $699/mo | 150,000 | 20,000 | — |

Overage: $0.04/100 lookups, $0.03/10 searches.

**Mapping to canonical schema:**

| UPCitemdb field | Schema table.column |
|----------------|-------------------|
| `upc` / `ean` | `barcode.gtin` |
| `brand` | `brand.name` |
| `title` | `shade.shade_name_canonical` (needs parsing) |
| `images[]` | `image_asset.url` |
| `offers[].price` | `sku.price_hint` |
| `offers[].link` | `sku.product_url` |

**Assessment:** The free tier (100/day) is sufficient for individual barcode scanning during
data entry. Returns brand, title, images, and pricing — but no color hex, ingredients, or
polish-specific attributes.

### 3.2 Barcode Lookup

| | |
|---|---|
| **URL** | `https://www.barcodelookup.com/api` |
| **Free tier** | 100 lookups/day, max 100 req/min |
| **Paid tiers** | Starter, Advanced, Professional, Enterprise |

Similar data to UPCitemdb. Good as a fallback if UPCitemdb is down or rate-limited.

### 3.3 Go-UPC

| | |
|---|---|
| **URL** | `https://go-upc.com/` |
| **Free tier** | None clear |
| **Paid** | From $19.95/mo for 5,000 calls, max 2 req/s |

Global barcode database. Less feature-rich API than UPCitemdb.

---

## 4. Ingredient & Safety Databases

### 4.1 EWG Skin Deep

| | |
|---|---|
| **URL** | `https://www.ewg.org/skindeep/` |
| **API** | ❌ None |
| **Nail polish coverage** | ~4,000-5,700 products (284 pages of browse results) |
| **Data contact** | `skindeep@ewg.org` |

**Browse URL:** `https://www.ewg.org/skindeep/browse/category/nail_polish/?page={N}`
**Product URL pattern:** `https://www.ewg.org/skindeep/products/{id}-{Brand_Product_Slug}/`

**Data per product:**
- Brand name, product name
- Overall hazard score (1-10, lower = safer)
- Data availability rating (Fair, Good, etc.)
- Concern categories: Cancer, Allergies & Immunotoxicity, Developmental/Reproductive Toxicity
- **Full ingredient list** with individual ingredient hazard scores
- Certifications (PETA Cruelty-Free, etc.)

**Assessment:** The richest source of nail polish ingredient + safety data available.
No API means scraping or partnership. Recommend contacting `skindeep@ewg.org` about data
licensing before building a scraper. If scraping, the URL structure is predictable
(sequential numeric IDs + slugified names, paginated category browse).

### 4.2 INCIDecoder

| | |
|---|---|
| **URL** | `https://incidecoder.com/` |
| **API** | ❌ None |

Science-based ingredient explanations with function classification, safety notes, and
research references. Written by a cosmetic formulator. More skincare-focused than nail polish.
Useful as a manual reference, not practical for automated ingestion.

### 4.3 CosDNA

| | |
|---|---|
| **URL** | `https://www.cosdna.com/` |
| **API** | ❌ None |

User-contributed ingredient lists with safety, acne, and irritation ratings per ingredient.
Data quality varies (user-submitted, may contain errors). Large database but no structured access.

### 4.4 CIR (Cosmetic Ingredient Review)

| | |
|---|---|
| **URL** | `https://www.cir-safety.org/` |
| **Reports** | `https://cir-reports.cir-safety.org/` |
| **API** | ❌ None (reports available as PDFs/web pages) |

Gold standard for ingredient safety data. Established 1976, backed by Personal Care Products
Council with FDA support. Contains safety assessment monographs for 4,740+ cosmetic ingredients.
All assessments and underlying safety data are public and non-proprietary.

Safety determination categories: safe as used, safe with qualifications, unsafe, insufficient data.

---

## 5. Retail & Affiliate Data

No major nail polish brand or retailer offers a public product API.

| Retailer | Affiliate Network | Product Feed? | Notes |
|----------|------------------|---------------|-------|
| Sephora | Rakuten | Yes (approved affiliates) | Structured product catalog with tracking URLs |
| Sally Beauty | Affiliate networks | Yes (daily-updated) | 6,000+ professional products including OPI, Gelish |
| Beyond Polish | FlexOffers / Rakuten / Sovrn | Yes | Multi-brand: OPI, CND, Essie, Kiara Sky, Cirque Colors |
| Ulta | — | No public feed | Third-party scrapers exist (Apify) |

**Rakuten Advertising API:** `https://developers.rakutenadvertising.com/`
- Product feeds in pipe-delimited text or XML
- 16 predefined product Class IDs with attribute fields
- Requires affiliate program membership + advertiser approval

**Third-party scraping services (paid):**
- Apify: Sephora scraper, Ulta scraper
- Oxylabs, Bright Data: Sephora scraper APIs
- Retailed.io: Sephora product API

**Assessment:** Affiliate product feeds via Rakuten are the most practical path to structured
retail data without scraping. The project's `seed_data_sources.sql` already lists both
Impact and Rakuten as data sources.

---

## 6. Community & Editorial Sites

### Temptalia

| | |
|---|---|
| **URL** | `https://www.temptalia.com/` |
| **Content** | 80,000+ makeup swatches, reviews with A+ to F grades |
| **API** | ❌ None |

Covers nail polish from Zoya, ILNP, Nails Inc., Tom Ford, and others. Highest quality
swatch photos and review data available anywhere. Operated by a single person — scraping
raises ethical concerns. Best treated as a manual reference or potential partnership.

### Lacquer Tracker

| | |
|---|---|
| **URL** | `https://www.lacquertracker.com/` |
| **Content** | 17,000+ nail polish colors with swatches, reviews, dupes |
| **API** | ❌ None |

One of the larger nail-polish-specific catalogs. Community-contributed data.
Forums, wishlists, mani check-ins. No structured data access documented.

### Lacquerly

| | |
|---|---|
| **URL** | `https://lacquer.ly/` |
| **Content** | Community-managed polish database for browsing/filtering collections |
| **API** | ❌ None |

### Cruelty-Free / Vegan Directories

| Site | URL | Data |
|------|-----|------|
| PETA Beauty Without Bunnies | `peta.org/lifestyle/personal-care-fashion/cruelty-free-nail-polish/` | Searchable cruelty-free brand list |
| Cruelty-Free Kitty | `crueltyfreekitty.com` | Curated brand status lists |
| Ethical Elephant | `ethicalelephant.com` | Vegan/cruelty-free directories |

All editorial/curated lists. No APIs. Would need manual transcription.

---

## 7. Regulatory Databases

### FDA MoCRA

| | |
|---|---|
| **URL** | `https://www.fda.gov/cosmetics/` |
| **Status** | Mandatory registration since 2023 (replaced voluntary VCRP) |
| **Coverage** | 9,528 active facility registrations, 589,762 active product listings (as of Jan 2025) |
| **API** | ❌ Not yet. Submitted via Cosmetics Direct portal. Public access mechanisms being developed. |

The most comprehensive US cosmetics registry that has ever existed. Primarily a regulatory
filing system — may not include full ingredients or consumer-facing details. Brand names per
facility are excluded from public disclosure.

**Related:** `openFDA Cosmetic Events API` (adverse event reports) — already in `seed_data_sources.sql`.

### EU CosIng

See [Section 2.3](#23-eu-cosing-cosmetic-ingredient-database) above.

---

## 8. Nail Polish Ingredient Reference

### 8.1 Typical Formula Composition

| Component | % by Weight | Role |
|-----------|-------------|------|
| Solvents | ~70% | Evaporate to form film |
| Film-forming polymers | ~15% | Create hard glossy coating |
| Thermoplastic resins | ~7% | Adhesion and gloss |
| Plasticizers | ~7% | Flexibility, prevent chipping |
| Pigments/colorants | ~1% | Color |
| Suspension agents | ~1% | Keep pigments distributed |

### 8.2 Common Ingredients by Function

#### Solvents

| INCI Name | CAS | Notes |
|-----------|-----|-------|
| Butyl Acetate | 123-86-4 | Primary solvent in most formulations |
| Ethyl Acetate | 141-78-6 | Fast-evaporating primary solvent |
| Isopropyl Alcohol | 67-63-0 | Co-solvent, viscosity adjustment |
| N-Butyl Alcohol | 71-36-3 | Co-solvent |
| Propylene Carbonate | 108-32-7 | Toluene replacement solvent |

Legacy/excluded: Toluene (3-free), Xylene (7-free), Acetone (16-free), MEK (21-free)

#### Film Formers

| INCI Name | CAS | Notes |
|-----------|-----|-------|
| Nitrocellulose | 9004-70-0 | Primary film former in nearly all polish |
| Cellulose Acetate Butyrate | 9004-36-8 | Alternative film former |
| Acrylates Copolymer | various | Secondary film former, gloss |
| Styrene/Acrylates Copolymer | various | Sparkle effects |

#### Resins (Adhesion + Gloss)

| INCI Name | Notes |
|-----------|-------|
| Phthalic Anhydride/Trimellitic Anhydride/Glycols Copolymer | Modern standard resin |
| Adipic Acid/Neopentyl Glycol/Trimellitic Anhydride Copolymer | Modern resin |
| Adipic Acid/Fumaric Acid/Phthalic Acid/Tricyclodecane Dimethanol Copolymer | Modern resin |
| Bis(Glycidoxyphenyl)Propane/Bisaminomethylnorbornane Copolymer | Epoxy resin |

Legacy/excluded: Tosylamide/Formaldehyde Resin (5-free)

#### Plasticizers

| INCI Name | CAS | Notes |
|-----------|-----|-------|
| Acetyl Tributyl Citrate | 77-90-7 | Modern DBP replacement |
| Trimethylpentanediyl Dibenzoate | 68052-02-8 | Flexibility, chip resistance |
| Glyceryl Tribenzoate | 614-33-5 | Flexibility |

Legacy/excluded: Dibutyl Phthalate (3-free), Camphor (5-free), TPHP (10-free)

#### UV Stabilizers

| INCI Name | CAS | Notes |
|-----------|-----|-------|
| Benzophenone-1 | 131-56-6 | Prevents color fading |
| Benzophenone-3 | 131-57-7 | Used in top coats |

#### Thickeners / Suspending Agents

| INCI Name | CAS | Notes |
|-----------|-----|-------|
| Stearalkonium Hectorite | 18748-34-2 | Suspends pigments |
| Stearalkonium Bentonite | 12141-33-6 | Suspending agent |
| Silica | 7631-86-9 | Texture, matting agent |

#### Colorants / Pigments

| INCI Name | CI Number | Effect |
|-----------|-----------|--------|
| Titanium Dioxide | CI 77891 | White, opacity |
| Iron Oxides | CI 77489/77491/77492/77499 | Red, yellow, brown, black |
| Ferric Ferrocyanide | CI 77510 | Blue |
| Chromium Oxide Greens | CI 77288 | Green (excluded 21-free) |
| Mica | CI 77019 | Shimmer, pearlescence |
| Aluminum Powder | CI 77000 | Metallic effect |
| Bismuth Oxychloride | CI 77163 | Pearl luster (excluded 21-free) |
| Ultramarines | CI 77007 | Blue/violet |

#### Treatment Additives (base coats)

| INCI Name | Function |
|-----------|----------|
| Tocopheryl Acetate (Vitamin E) | Nail conditioning |
| Retinyl Palmitate (Vitamin A) | Nail strengthening |
| Panthenol (Vitamin B5) | Moisture retention |
| Citric Acid | pH adjuster, stabilizer |

#### Real-World INCI Example (10-free formula, ella+mila)

```
Butyl Acetate, Ethyl Acetate, Nitrocellulose, Acetyl Tributyl Citrate,
Phthalic Anhydride/Trimellitic Anhydride/Glycols Copolymer,
Isopropyl Alcohol, Stearalkonium Hectorite,
Adipic Acid/Fumaric Acid/Phthalic Acid/Tricyclodecane Dimethanol Copolymer,
Citric Acid,
Bis(glycidoxyphenyl)propane/Bisaminomethylnorbornane Copolymer,
Aluminum Hydroxide, Polybutylene Terephthalate, Polyethylene Terephthalate,
Styrene/Acrylates Copolymer
[+/- colorants]
```

---

### 8.3 "Free-From" Tier Definitions

> ⚠️ **No industry standard body regulates these claims.** Brands self-define their lists.
> There is strong consensus at the 3/5/7 level but significant variation above that.

#### 3-Free — "The Toxic Trio"

| # | Ingredient | CAS | Concern |
|---|-----------|-----|---------|
| 1 | Formaldehyde | 50-00-0 | Known carcinogen (hardening agent) |
| 2 | Toluene | 108-88-3 | CNS depressant (solvent) |
| 3 | Dibutyl Phthalate (DBP) | 84-74-2 | Endocrine disruptor; banned in EU cosmetics since 2004 |

#### 5-Free (adds to 3-free)

| # | Ingredient | CAS | Concern |
|---|-----------|-----|---------|
| 4 | Formaldehyde Resin (Tosylamide/Formaldehyde Resin) | 25035-71-4 | Allergen (adhesion resin) |
| 5 | Camphor | 76-22-2 | Skin irritant at high concentrations (plasticizer) |

#### 7-Free (adds to 5-free)

| # | Ingredient | CAS | Concern |
|---|-----------|-----|---------|
| 6 | Ethyl Tosylamide | 1077-56-1 | Antibiotic-resistance concern; banned in EU cosmetics |
| 7 | Xylene | 1330-20-7 | Respiratory irritant (solvent) |

#### 10-Free (adds to 7-free)

| # | Ingredient | CAS | Concern |
|---|-----------|-----|---------|
| 8 | Triphenyl Phosphate (TPHP) | 115-86-6 | Endocrine disruptor (plasticizer/flame retardant) |
| 9 | Parabens (class) | various | Endocrine concerns (preservatives) |
| 10 | tert-Butyl Hydroperoxide (TBHP) | 75-91-2 | Skin irritant (catalyst) |

> Some brands substitute animal-derived ingredients or broad phthalates for TBHP at this tier.

#### 13-Free (adds to 10-free) — brand-dependent

| # | Ingredient | CAS | Notes |
|---|-----------|-----|-------|
| 11 | Gluten | — | Binding agent in some formulations |
| 12 | Animal-Derived Ingredients | — | e.g., Guanine from fish scales for shimmer |
| 13 | Lead / Sulfates | 7439-92-1 / various | Contaminant / surfactants |

#### 16-Free (adds to 13-free) — brand-dependent

| # | Ingredient | CAS | Notes |
|---|-----------|-----|-------|
| 14 | Acetone | 67-64-1 | Solvent |
| 15 | Styrene | 100-42-5 | Possible carcinogen |
| 16 | Bisphenol A (BPA) | 80-05-7 | Endocrine disruptor |
| 17 | Glycol Ethers of Series E | various | Reproductive toxicity concerns |
| 18 | Nonylphenol Ethoxylate | various | Endocrine disruptor |
| 19 | MEHQ / Hydroquinone Monomethyl Ether | 150-76-5 | Skin sensitizer |

#### 21-Free — most comprehensive tier currently marketed

Adds to the above: Benzene, Cyclic Silicones, Methyl Ethyl Ketone (MEK), Hydroquinone (HQ),
Chromium Oxide Greens, Bismuth Oxychloride, CMR Substances (class), Synthetic Fragrances (class).

Reference: Liberation Nails publishes a detailed 21-free breakdown.

---

### 8.4 Canonical Excluded-Ingredients Table

This is the superset of all ingredients tracked across free-from tiers. Recommended for the
`claim` / `label_claim` tables in the canonical schema.

| # | Ingredient | CAS | First Excluded At |
|---|-----------|-----|-------------------|
| 1 | Formaldehyde | 50-00-0 | 3-free |
| 2 | Toluene | 108-88-3 | 3-free |
| 3 | Dibutyl Phthalate (DBP) | 84-74-2 | 3-free |
| 4 | Formaldehyde Resin | 25035-71-4 | 5-free |
| 5 | Camphor | 76-22-2 | 5-free |
| 6 | Ethyl Tosylamide | 1077-56-1 | 7-free |
| 7 | Xylene | 1330-20-7 | 7-free |
| 8 | Triphenyl Phosphate (TPHP) | 115-86-6 | 10-free |
| 9 | Parabens (class) | various | 10-free |
| 10 | tert-Butyl Hydroperoxide | 75-91-2 | 10-free |
| 11 | Animal-Derived Ingredients | — | 13-free |
| 12 | Gluten | — | 13-free |
| 13 | Lead | 7439-92-1 | 13-free |
| 14 | Sulfates (class) | various | 13-free |
| 15 | Acetone | 67-64-1 | 16-free |
| 16 | Styrene | 100-42-5 | 16-free |
| 17 | Bisphenol A (BPA) | 80-05-7 | 16-free |
| 18 | Glycol Ethers of Series E | various | 16-free |
| 19 | Nonylphenol Ethoxylate | various | 16-free |
| 20 | MEHQ | 150-76-5 | 16-free |
| 21 | Benzene | 71-43-2 | 21-free |
| 22 | Cyclic Silicones | various | 21-free |
| 23 | Methyl Ethyl Ketone (MEK) | 78-93-3 | 21-free |
| 24 | Hydroquinone (HQ) | 123-31-9 | 21-free |
| 25 | Chromium Oxide Greens | 1308-38-9 | 21-free |
| 26 | Bismuth Oxychloride | 7787-59-9 | 21-free |
| 27 | CMR Substances (class) | various | 21-free |
| 28 | Synthetic Fragrances (class) | various | 21-free |

**Data model note:** A polish's free-from tier can be **computed** from its ingredient list by
checking which of these 28 items are absent. Store the `freeFromTier` as a derived value
(3, 5, 7, 10, 13, 16, 21) on the `label_document` or `sku`.

---

## 9. Recommended Integration Strategy

### Phase 1 — MVP (no cost, immediate)

| Action | Source | Schema Tables Populated |
|--------|--------|------------------------|
| Import CosIng CSV | EU CosIng | `ingredient` (INCI names, CAS, functions) |
| Ingest Makeup API | Makeup API | `brand`, `shade`, `color_features` (hex seeds) |
| Wire up barcode lookup | UPCitemdb free tier | `barcode`, `brand`, `shade` (name parsing) |
| Seed free-from claims | Section 8.4 above | `claim`, reference data for tier computation |

### Phase 2 — Enrichment (low cost, requires signup)

| Action | Source | Schema Tables Populated |
|--------|--------|------------------------|
| Join affiliate programs | Rakuten / Impact | `sku` (price, URLs), `product_line` |
| Import affiliate product feeds | Sally Beauty, Beyond Polish, Sephora | `brand`, `product_line`, `shade`, `sku` |
| Add barcode fallback | Barcode Lookup | `barcode` (redundancy for UPCitemdb) |

### Phase 3 — Deep Data (higher effort)

| Action | Source | Schema Tables Populated |
|--------|--------|------------------------|
| Contact EWG for data license | EWG Skin Deep | `label_document`, `label_ingredient` (full INCI lists + safety scores) |
| Brand website scraping (if legal review passes) | OPI, Essie, Zoya, etc. | `product_line`, `shade`, `label_document` |
| Community data partnerships | Lacquer Tracker, Temptalia | `swatch`, `shade` (dupes, editorial grades) |

### Phase 4 — Crowdsourced (long-term)

| Action | Source | Schema Tables Populated |
|--------|--------|------------------------|
| User barcode scanning | UserCapture | `barcode` → all tables via matching pipeline |
| User ingredient label photos | UserCapture + OCR/AI | `label_document`, `label_ingredient` |
| User swatch photo uploads | UserCapture | `swatch`, `color_features` |
| Moderated community submissions | User contributions | `user_submission` → `proposal_patch` → canonical |

### Key Gaps with No Good Programmatic Source

| Attribute | Workaround |
|-----------|-----------|
| **Finish type** (creme, shimmer, glitter, jelly, etc.) | NLP extraction from product names/descriptions |
| **"Free-from" tier claims** | Parse from brand websites; compute from ingredient lists |
| **Collection / product line** | Scrape from brand sites or affiliate feeds |
| **Complete ingredient lists** (broadly) | EWG partnership, user contributions, label OCR |

---

## 10. Holo Taco Ingestion Options (Decision Record)

Context: We need recent Holo Taco shades to remain searchable in-app, while acknowledging
that Shopify storefront data does not provide explicit hex values.

| Option | Scope | Effort | Pros | Risks/Limitations |
|--------|-------|--------|------|-------------------|
| 1. Ingest now, no hex | Import searchable metadata only (`brand`, `shade`, `collection`, `finish`, tags, image URL, SKU/barcode) | ~1 day | Fastest path; highest reliability; unblocks recent catalog updates | No precise color filtering by hex |
| 2. Ingest + derived `approx_hex` | Option 1 + simple dominant-color extraction from product images | ~2-3 days | Enables basic color filters and color chips | Effect polishes (holo/magnetic/multichrome) can produce misleading single hex |
| 3. Ingest + curated overrides | Option 2 + manual override table for key/new shades | Ongoing ops | Better accuracy where it matters most | Requires maintenance workflow |
| 4. Embedding-first color search | Store image embeddings for similarity/dupe retrieval, keep hex optional | ~1-2 weeks initial | Better fit for effect-heavy finishes; avoids over-trusting single hex | Higher implementation complexity |

**Recommended sequence:**
1. Ship Option 1 immediately for searchable recency coverage.
2. Add Option 2 with explicit `approx_hex` + confidence metadata.
3. Add Option 4 when visual search/dupe ranking becomes priority.
