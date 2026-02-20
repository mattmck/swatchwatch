-- Up Migration

-- 005_seed_production_reference_data.sql
-- Idempotent production reference/catalog data.
-- This is the data every environment needs to function — brands, finishes,
-- claims, retailers, data sources, disclosure config, and baseline ingredients.
-- Uses ON CONFLICT DO NOTHING throughout so it's safe to re-run.

BEGIN;

-- ─── Finish Types (new reference table) ───────────────────────────────────────
-- shade.finish remains free-text for now; this table is the canonical list
-- the frontend and API validate against. A future migration can add a FK.

CREATE TABLE IF NOT EXISTS finish_type (
  finish_type_id SMALLSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,       -- stored value (matches shade.finish)
  display_name   TEXT NOT NULL,              -- UI label
  description    TEXT,
  sort_order     SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO finish_type (name, display_name, description, sort_order) VALUES
  ('creme',        'Creme',        'Opaque, no shimmer or sparkle',                          1),
  ('sheer',        'Sheer',        'Translucent, buildable coverage',                        2),
  ('jelly',        'Jelly',        'Translucent with a squishy, glossy look',                3),
  ('shimmer',      'Shimmer',      'Fine light-reflecting particles',                        4),
  ('metallic',     'Metallic',     'Foil-like, mirror-finish sheen',                         5),
  ('glitter',      'Glitter',      'Visible glitter particles in a clear or tinted base',    6),
  ('holographic',  'Holographic',  'Prismatic rainbow effect (linear or scattered)',          7),
  ('duochrome',    'Duochrome',    'Shifts between two colors at different angles',           8),
  ('multichrome',  'Multichrome',  'Shifts across three or more colors',                     9),
  ('flake',        'Flake',        'Irregular metallic or iridescent flakes',                10),
  ('matte',        'Matte',        'Non-shiny, flat finish (may need matte top coat)',       11),
  ('topper',       'Topper',       'Meant to layer over another polish',                    12),
  ('magnetic',     'Magnetic',     'Contains iron particles shaped with a magnet',           13),
  ('thermal',      'Thermal',      'Color changes with temperature',                        14),
  ('crelly',       'Crelly',       'Cream/jelly hybrid; semi-sheer squishy base',           15),
  ('glow',         'Glow',         'Glow-in-the-dark or UV-reactive',                       16),
  ('other',        'Other',        'Finish not covered by standard categories',              99)
ON CONFLICT (name) DO NOTHING;


-- ─── Data Sources ─────────────────────────────────────────────────────────────
-- Moved from docs/seed_data_sources.sql into the migration pipeline.

INSERT INTO data_source (name, source_type, base_url, license, terms_url, enabled, metadata) VALUES
  ('ManualEntry',           'manual', NULL,
   NULL, NULL, true,
   '{"priority":"high","mvp":"yes","notes":"Admin/user manual edits and corrections."}'::jsonb),
  ('UserCapture',           'api',    NULL,
   NULL, NULL, true,
   '{"priority":"highest","mvp":"yes","notes":"App-generated evidence: barcode frames, label photos, swatches."}'::jsonb),
  ('OpenBeautyFacts',       'api',    'https://world.openbeautyfacts.org',
   'Open Database License (ODbL)', 'https://world.openbeautyfacts.org/terms-of-use', true,
   '{"priority":"high","mvp":"yes","notes":"Barcode-first bootstrap for product name/brand. Coverage varies; cache by GTIN."}'::jsonb),
  ('CosIng',                'api',    'https://ec.europa.eu/growth/sectors/cosmetics/cosing',
   'EU reference database', 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en', true,
   '{"priority":"medium","mvp":"yes","notes":"Ingredient ontology/normalization (INCI names, functions). Not a product catalog."}'::jsonb),
  ('ImpactAffiliateNetwork','api',    'https://impact.com',
   'Affiliate program terms per retailer/network', 'https://impact.com/partner', true,
   '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and product feeds via Impact."}'::jsonb),
  ('RakutenAdvertising',    'api',    'https://rakutenadvertising.com',
   'Affiliate program terms per retailer/network', 'https://developers.rakutenadvertising.com', true,
   '{"priority":"high","mvp":"yes","notes":"Retail deeplinks and reporting via Rakuten Advertising."}'::jsonb),
  ('GS1Lookup',             'api',    'https://www.gs1.org',
   'May be paid/limited', 'https://www.gs1.org/services/verified-by-gs1', false,
   '{"priority":"low","mvp":"no","notes":"Optional GTIN validation / brand owner enrichment."}'::jsonb),
  ('openFDA_CosmeticEvents','api',    'https://open.fda.gov/apis/cosmetic/event/',
   'Public API', 'https://open.fda.gov/apis/', false,
   '{"priority":"low","mvp":"no","notes":"Adverse event signals (not ingredients). Use careful UX and disclaimers."}'::jsonb)
ON CONFLICT (name) DO NOTHING;


-- ─── Brands ───────────────────────────────────────────────────────────────────
-- Major nail polish brands. Not exhaustive — users and ingestion pipelines add more.

INSERT INTO brand (name_canonical) VALUES
  -- Mass market / drugstore
  ('OPI'),
  ('Essie'),
  ('Sally Hansen'),
  ('China Glaze'),
  ('Orly'),
  ('Revlon'),
  ('Sinful Colors'),
  ('L.A. Colors'),
  ('Kiss'),
  ('Wet n Wild'),
  -- Professional / salon
  ('CND'),
  ('Gelish'),
  ('DND'),
  ('Kiara Sky'),
  ('Madam Glam'),
  -- Prestige / department store
  ('Butter London'),
  ('Deborah Lippmann'),
  ('Smith & Cult'),
  ('JINsoon'),
  ('Nails Inc'),
  ('Côte'),
  ('Tenoverten'),
  ('Kure Bazaar'),
  -- Luxury
  ('Chanel'),
  ('Dior'),
  ('Tom Ford'),
  ('Hermès'),
  ('YSL'),
  ('Gucci'),
  -- Indie
  ('ILNP'),
  ('Cirque Colors'),
  ('Holo Taco'),
  ('Zoya'),
  ('KBShimmer'),
  ('A-England'),
  ('Painted Polish'),
  ('Mooncat'),
  ('Lights Lacquer'),
  ('Loud Lacquer'),
  ('Starrily'),
  ('BLUSH Lacquers'),
  ('Polished for Days'),
  ('Bee''s Knees Lacquer'),
  ('Cadillacquer'),
  ('Emily de Molly'),
  ('F.U.N Lacquer'),
  ('Femme Fatale'),
  ('Glam Polish'),
  ('Live Love Polish')
ON CONFLICT (name_canonical) DO NOTHING;


-- ─── Brand Aliases ────────────────────────────────────────────────────────────
-- Common misspellings, abbreviations, and voice-input variations.
-- Alias text is lowercased for case-insensitive fuzzy matching.

INSERT INTO brand_alias (brand_id, alias)
SELECT b.brand_id, a.alias
FROM (VALUES
  ('OPI',               'opi'),
  ('OPI',               'o.p.i.'),
  ('OPI',               'o.p.i'),
  ('OPI',               'oh pee eye'),
  ('Essie',             'essie'),
  ('Sally Hansen',      'sally hansen'),
  ('Sally Hansen',      'sally hanson'),
  ('Sally Hansen',      'sally hansens'),
  ('China Glaze',       'china glaze'),
  ('Orly',              'orly'),
  ('Revlon',            'revlon'),
  ('Sinful Colors',     'sinful colors'),
  ('Sinful Colors',     'sinful colours'),
  ('CND',               'cnd'),
  ('CND',               'creative nail design'),
  ('Butter London',     'butter london'),
  ('Butter London',     'butter'),
  ('Deborah Lippmann',  'deborah lippmann'),
  ('Deborah Lippmann',  'lippmann'),
  ('Smith & Cult',      'smith and cult'),
  ('Smith & Cult',      'smith & cult'),
  ('JINsoon',           'jinsoon'),
  ('JINsoon',           'jin soon'),
  ('Nails Inc',         'nails inc'),
  ('Nails Inc',         'nails inc.'),
  ('Côte',              'cote'),
  ('Côte',              'coté'),
  ('Tenoverten',        'tenoverten'),
  ('Tenoverten',        'ten over ten'),
  ('Kure Bazaar',       'kure bazaar'),
  ('Chanel',            'chanel'),
  ('Chanel',            'chanel le vernis'),
  ('Dior',              'dior'),
  ('Dior',              'dior vernis'),
  ('Tom Ford',          'tom ford'),
  ('Hermès',            'hermes'),
  ('Hermès',            'hermès'),
  ('YSL',               'ysl'),
  ('YSL',               'yves saint laurent'),
  ('Gucci',             'gucci'),
  ('ILNP',              'ilnp'),
  ('ILNP',              'i love nail polish'),
  ('Cirque Colors',     'cirque colors'),
  ('Cirque Colors',     'cirque'),
  ('Holo Taco',         'holo taco'),
  ('Holo Taco',         'holotaco'),
  ('Zoya',              'zoya'),
  ('KBShimmer',         'kbshimmer'),
  ('KBShimmer',         'kb shimmer'),
  ('A-England',         'a-england'),
  ('A-England',         'a england'),
  ('Mooncat',           'mooncat'),
  ('Mooncat',           'moon cat'),
  ('Lights Lacquer',    'lights lacquer'),
  ('Starrily',          'starrily'),
  ('Emily de Molly',    'emily de molly'),
  ('F.U.N Lacquer',     'fun lacquer'),
  ('F.U.N Lacquer',     'f.u.n lacquer'),
  ('Femme Fatale',      'femme fatale'),
  ('Glam Polish',       'glam polish'),
  ('Live Love Polish',  'live love polish')
) AS a(brand_name, alias)
JOIN brand b ON b.name_canonical = a.brand_name
ON CONFLICT DO NOTHING;


-- ─── Claims ───────────────────────────────────────────────────────────────────
-- Standard cosmetic/nail polish marketing claims for label parsing and filtering.

INSERT INTO claim (claim_type, claim_text_raw) VALUES
  -- Free-from claims
  ('free_from', '3-Free (no Toluene, Formaldehyde, DBP)'),
  ('free_from', '5-Free'),
  ('free_from', '7-Free'),
  ('free_from', '8-Free'),
  ('free_from', '10-Free'),
  ('free_from', '12-Free'),
  ('free_from', '13-Free'),
  ('free_from', '16-Free'),
  ('free_from', '21-Free'),
  ('free_from', 'Formaldehyde-Free'),
  ('free_from', 'Toluene-Free'),
  ('free_from', 'DBP-Free'),
  ('free_from', 'Camphor-Free'),
  ('free_from', 'TPHP-Free'),
  ('free_from', 'Paraben-Free'),
  ('free_from', 'Xylene-Free'),
  -- Ethics / sustainability
  ('ethics',    'Vegan'),
  ('ethics',    'Cruelty-Free'),
  ('ethics',    'Leaping Bunny Certified'),
  ('ethics',    'PETA Certified'),
  ('ethics',    'B Corp Certified'),
  ('ethics',    'Sustainable Packaging'),
  ('ethics',    'Carbon Neutral'),
  -- Performance
  ('performance', 'Gel-Effect'),
  ('performance', 'Long-Wear'),
  ('performance', 'Quick-Dry'),
  ('performance', 'Chip-Resistant'),
  ('performance', 'No Base Coat Needed'),
  ('performance', 'No Top Coat Needed'),
  ('performance', 'Peel-Off'),
  ('performance', 'Breathable'),
  -- Safety / regulatory
  ('safety',    'Non-Toxic'),
  ('safety',    'Pregnancy-Safe'),
  ('safety',    'Kid-Safe'),
  ('safety',    'Dermatologist Tested'),
  ('safety',    'Hypoallergenic')
ON CONFLICT DO NOTHING;


-- ─── Retailers ────────────────────────────────────────────────────────────────

INSERT INTO retailer (name, country_codes, supports_deeplink, app_uri_scheme, homepage_url) VALUES
  ('Ulta Beauty',       '{US}',         true,  'ulta://',      'https://www.ulta.com'),
  ('Sephora',           '{US,CA,FR}',   true,  'sephora://',   'https://www.sephora.com'),
  ('Amazon',            '{US,CA,GB,DE}',true,  'amzn://',      'https://www.amazon.com'),
  ('Target',            '{US}',         true,  NULL,            'https://www.target.com'),
  ('Walmart',           '{US}',         true,  NULL,            'https://www.walmart.com'),
  ('Sally Beauty',      '{US,CA}',      false, NULL,            'https://www.sallybeauty.com'),
  ('CVS',               '{US}',         false, NULL,            'https://www.cvs.com'),
  ('Walgreens',         '{US}',         false, NULL,            'https://www.walgreens.com'),
  ('Nordstrom',         '{US,CA}',      true,  NULL,            'https://www.nordstrom.com'),
  ('Beautylish',        '{US}',         false, NULL,            'https://www.beautylish.com'),
  ('Beyond Polish',     '{US}',         false, NULL,            'https://www.beyondpolish.com'),
  ('HBBeautyBar',       '{US}',         false, NULL,            'https://www.hbbeautybar.com'),
  ('Zoya.com',          '{US}',         false, NULL,            'https://www.zoya.com'),
  ('OPI.com',           '{US}',         false, NULL,            'https://www.opi.com'),
  ('Essie.com',         '{US}',         false, NULL,            'https://www.essie.com'),
  ('HoloTaco.com',      '{US,CA,GB}',   false, NULL,            'https://www.holotaco.com'),
  ('ILNP.com',          '{US}',         false, NULL,            'https://www.ilnp.com'),
  ('CirqueColors.com',  '{US}',         false, NULL,            'https://www.cirquecolors.com')
ON CONFLICT (name) DO NOTHING;


-- ─── Affiliate Programs (stubs — fill in publisher IDs when accounts are live) ─

INSERT INTO affiliate_program (retailer_id, network, publisher_account_id, status, terms_notes)
SELECT r.retailer_id, a.network, NULL, 'paused', a.terms_notes
FROM (VALUES
  ('Ulta Beauty',   'impact',  'Apply via Impact. Commission ~2-5%.'),
  ('Sephora',       'rakuten', 'Apply via Rakuten. Commission ~5%.'),
  ('Amazon',        'amazon',  'Amazon Associates. Commission ~1-3% beauty.'),
  ('Target',        'impact',  'Apply via Impact. Commission ~1-5%.'),
  ('Nordstrom',     'rakuten', 'Apply via Rakuten. Commission ~2-5%.'),
  ('Sally Beauty',  'impact',  'Apply via Impact.'),
  ('Beautylish',    'direct',  'Inquire directly with Beautylish.')
) AS a(retailer_name, network, terms_notes)
JOIN retailer r ON r.name = a.retailer_name
ON CONFLICT DO NOTHING;


-- ─── Disclosure Config ────────────────────────────────────────────────────────
-- FTC-compliant affiliate disclosure text, per environment.

INSERT INTO disclosure_config (env, disclosure_text) VALUES
  ('dev',  'Links may be affiliate links (dev environment).'),
  ('stg',  'Links may be affiliate links (staging environment).'),
  ('prod', 'Some links are affiliate links. SwatchWatch may earn a small commission at no extra cost to you. This helps keep the app free!')
ON CONFLICT (env) DO NOTHING;


-- ─── Baseline Ingredients (common nail polish INCI names) ─────────────────────
-- Not exhaustive — CosIng ingestion will add more. This covers the most common
-- ingredients you'd find on a typical nail polish label.

INSERT INTO ingredient (inci_name_canonical) VALUES
  -- Solvents
  ('Butyl Acetate'),
  ('Ethyl Acetate'),
  ('Isopropyl Alcohol'),
  ('Propyl Acetate'),
  ('Diacetone Alcohol'),
  -- Film formers
  ('Nitrocellulose'),
  ('Adipic Acid/Neopentyl Glycol/Trimellitic Anhydride Copolymer'),
  ('Acrylates Copolymer'),
  ('Cellulose Acetate Butyrate'),
  -- Plasticizers
  ('Acetyl Tributyl Citrate'),
  ('Trimethyl Pentanyl Diisobutyrate'),
  ('Dibutyl Phthalate'),
  ('Triphenyl Phosphate'),
  ('Sucrose Acetate Isobutyrate'),
  -- Resins
  ('Tosylamide/Formaldehyde Resin'),
  ('Tosylamide/Epoxy Resin'),
  -- Pigments / colorants
  ('CI 77891'),    -- Titanium Dioxide
  ('CI 77491'),    -- Iron Oxide Red
  ('CI 77492'),    -- Iron Oxide Yellow
  ('CI 77499'),    -- Iron Oxide Black
  ('CI 15850'),    -- Red 6 / Red 7
  ('CI 77510'),    -- Ferric Ferrocyanide (Prussian Blue)
  ('CI 77000'),    -- Aluminum Powder
  ('CI 77163'),    -- Bismuth Oxychloride
  ('CI 19140'),    -- Yellow 5
  ('CI 15985'),    -- Yellow 6
  ('CI 42090'),    -- Blue 1
  ('CI 73360'),    -- Red 30
  ('Mica'),
  ('Calcium Aluminum Borosilicate'),
  ('Calcium Sodium Borosilicate'),
  ('Synthetic Fluorphlogopite'),
  -- UV filters / stabilizers
  ('Benzophenone-1'),
  ('Etocrylene'),
  -- Thickeners / suspending agents
  ('Stearalkonium Bentonite'),
  ('Silica'),
  ('Hectorite'),
  -- Other common
  ('Camphor'),
  ('Formaldehyde'),
  ('Toluene'),
  ('Xylene'),
  ('Ethyl Tosylamide'),
  ('N-Butyl Alcohol'),
  ('Isosorbide Dicaprylate/Caprate'),
  ('Tin Oxide'),
  ('Polyethylene Terephthalate'),  -- glitter base
  ('Acrylates/Octylacrylamide Copolymer')
ON CONFLICT (inci_name_canonical) DO NOTHING;


-- ─── Product Lines (major brands only) ────────────────────────────────────────

INSERT INTO product_line (brand_id, name_canonical)
SELECT b.brand_id, pl.line_name
FROM (VALUES
  ('OPI',           'Infinite Shine'),
  ('OPI',           'GelColor'),
  ('OPI',           'Nail Lacquer'),
  ('OPI',           'Nature Strong'),
  ('OPI',           'xPRESS/ON'),
  ('Essie',         'Original'),
  ('Essie',         'Gel Couture'),
  ('Essie',         'Expressie'),
  ('Sally Hansen',  'Insta-Dri'),
  ('Sally Hansen',  'Miracle Gel'),
  ('Sally Hansen',  'Good. Kind. Pure.'),
  ('Sally Hansen',  'Xtreme Wear'),
  ('China Glaze',   'Nail Lacquer'),
  ('Orly',          'Nail Lacquer'),
  ('Orly',          'Breathable'),
  ('CND',           'Vinylux'),
  ('CND',           'Shellac'),
  ('Zoya',          'Nail Lacquer'),
  ('Zoya',          'Pixie Dust'),
  ('Zoya',          'Naked Manicure'),
  ('Holo Taco',     'Crème'),
  ('Holo Taco',     'Linear Holo'),
  ('Holo Taco',     'Scattered Holo'),
  ('Holo Taco',     'Flakie Holo'),
  ('Holo Taco',     'Multichromes'),
  ('Butter London', 'Patent Shine 10X'),
  ('Butter London', 'Glazen'),
  ('ILNP',          'Ultra Chromes'),
  ('ILNP',          'Holos'),
  ('ILNP',          'Cremes'),
  ('Cirque Colors', 'Crème'),
  ('Cirque Colors', 'Shimmer'),
  ('Cirque Colors', 'Thermal'),
  ('Chanel',        'Le Vernis'),
  ('Dior',          'Vernis'),
  ('Tom Ford',      'Nail Lacquer'),
  ('Deborah Lippmann', 'Gel Lab Pro')
) AS pl(brand_name, line_name)
JOIN brand b ON b.name_canonical = pl.brand_name
ON CONFLICT (brand_id, name_canonical) DO NOTHING;


COMMIT;


-- Down Migration

BEGIN;

DELETE FROM product_line WHERE brand_id IN (
  SELECT brand_id FROM brand WHERE name_canonical IN (
    'OPI','Essie','Sally Hansen','China Glaze','Orly','CND','Zoya',
    'Holo Taco','Butter London','ILNP','Cirque Colors','Chanel',
    'Dior','Tom Ford','Deborah Lippmann'
  )
);

DELETE FROM ingredient;
DELETE FROM disclosure_config;

DELETE FROM affiliate_program WHERE retailer_id IN (
  SELECT retailer_id FROM retailer
);
DELETE FROM retailer;

DELETE FROM claim;

DELETE FROM brand_alias WHERE brand_id IN (
  SELECT brand_id FROM brand
);
-- Note: don't delete brands here — 003 owns the dev brands and its down handles those.
-- Only delete brands that 005 added beyond the 003 set.
DELETE FROM brand WHERE name_canonical IN (
  'Revlon','Sinful Colors','L.A. Colors','Kiss','Wet n Wild',
  'CND','Gelish','DND','Kiara Sky','Madam Glam',
  'Deborah Lippmann','Smith & Cult','JINsoon','Nails Inc','Côte','Tenoverten','Kure Bazaar',
  'Chanel','Dior','Tom Ford','Hermès','YSL','Gucci',
  'KBShimmer','A-England','Painted Polish','Mooncat','Lights Lacquer','Loud Lacquer',
  'Starrily','BLUSH Lacquers','Polished for Days','Bee''s Knees Lacquer','Cadillacquer',
  'Emily de Molly','F.U.N Lacquer','Femme Fatale','Glam Polish','Live Love Polish'
);

DELETE FROM data_source;

DROP TABLE IF EXISTS finish_type;

COMMIT;
