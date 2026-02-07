-- 003_seed_dev_data.sql
-- Idempotent seed data for the dev environment.
-- Inserts brands, shades, one demo user, and inventory items that mirror
-- the original mock-data.ts so every frontend page has data to display.
-- Safe to re-run: uses ON CONFLICT DO NOTHING throughout.

BEGIN;

-- ─── Demo user ──────────────────────────────────────────────────────────────
INSERT INTO app_user (user_id, handle) VALUES (1, 'demo-user')
  ON CONFLICT (user_id) DO NOTHING;

-- Reset the sequence so the next user gets id 2+
SELECT setval('app_user_user_id_seq', GREATEST(1, (SELECT MAX(user_id) FROM app_user)));

-- ─── Brands ─────────────────────────────────────────────────────────────────
INSERT INTO brand (name_canonical) VALUES
  ('OPI'),
  ('Essie'),
  ('ILNP'),
  ('Zoya'),
  ('Cirque Colors'),
  ('Holo Taco'),
  ('China Glaze'),
  ('Sally Hansen'),
  ('Orly'),
  ('Butter London')
ON CONFLICT (name_canonical) DO NOTHING;

-- ─── Shades ─────────────────────────────────────────────────────────────────
-- Each shade references a brand by name_canonical lookup
INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status) VALUES
  -- Original 10 mock-data polishes
  ((SELECT brand_id FROM brand WHERE name_canonical = 'OPI'),           'Big Apple Red',              'cream',        'Iconic Shades',    'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Essie'),         'Ballet Slippers',            'sheer',        'Essie Originals',  'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'ILNP'),          'Mega',                       'holographic',  'ILNP Originals',   'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Zoya'),          'Willa',                      'cream',        'Zoya Naturel',     'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'OPI'),           'Lincoln Park After Dark',    'cream',        'Iconic Shades',    'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Cirque Colors'), 'Lullaby',                    'cream',        'Aura Collection',  'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Holo Taco'),     'Scattered Holo Taco',        'topper',       'Holo Taco Toppers','active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Essie'),         'Wicked',                     'cream',        'Essie Originals',  'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'ILNP'),          'Cygnus Loop',                'multichrome',  'ILNP Originals',   'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'OPI'),           'Funny Bunny',                'sheer',        'Soft Shades',      'active'),
  -- 10 additional polishes for variety
  ((SELECT brand_id FROM brand WHERE name_canonical = 'China Glaze'),   'Ruby Pumps',                 'glitter',      'Holiday Joy',      'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Sally Hansen'),  'Black Out',                  'cream',        'Insta-Dri',        'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Holo Taco'),     'One Coat Black',             'cream',        'Holo Taco Cremes', 'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Orly'),          'Seize the Day',              'shimmer',      'Day Trippin',      'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Zoya'),          'Pixie Dust Lux',             'matte',        'Pixie Dust',       'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'OPI'),           'Do You Lilac It?',           'cream',        'Iconic Shades',    'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Essie'),         'Mint Candy Apple',           'cream',        'Essie Originals',  'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'ILNP'),          'Eclipse',                    'multichrome',  'Ultra Chromes',    'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'Butter London'), 'Teddy Girl',                 'cream',        'Patent Shine',     'active'),
  ((SELECT brand_id FROM brand WHERE name_canonical = 'China Glaze'),   'Fairy Dust',                 'glitter',      'Holiday Joy',      'active')
ON CONFLICT DO NOTHING;

-- ─── Inventory Items (with the new user-facing columns from migration 002) ──
-- Maps to the original 10 mock polishes, plus 10 extras
INSERT INTO user_inventory_item
  (user_id, shade_id, quantity, color_name, color_hex, rating, tags, size_display, notes, purchase_date, created_at, updated_at)
VALUES
  -- 1: OPI Big Apple Red
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Big Apple Red' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'OPI') LIMIT 1),
   2, 'Red', '#C4113C', 5, ARRAY['classic','favorite'], '15ml',
   'The perfect classic red. Two coats for full opacity.',
   '2025-12-01', '2025-12-15T10:00:00Z', '2025-12-15T10:00:00Z'),

  -- 2: Essie Ballet Slippers
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Ballet Slippers' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Essie') LIMIT 1),
   1, 'Pale Pink', '#F4C2C2', 4, ARRAY['everyday','classic'], '13.5ml',
   'Sheer pink, great for everyday. 3 coats needed.',
   '2025-12-05', '2025-12-20T09:00:00Z', '2025-12-20T09:00:00Z'),

  -- 3: ILNP Mega
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Mega' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'ILNP') LIMIT 1),
   1, 'Teal', '#008080', 5, ARRAY['indie','favorite','holographic'], '12ml',
   'Stunning linear holo, one of the best in the collection.',
   '2025-12-10', '2025-12-25T14:00:00Z', '2025-12-25T14:00:00Z'),

  -- 4: Zoya Willa
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Willa' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Zoya') LIMIT 1),
   1, 'Lavender', '#C9A0DC', 4, ARRAY['spring','pastel'], '15ml',
   'Beautiful soft lavender cream.',
   '2025-12-12', '2025-12-28T11:00:00Z', '2025-12-28T11:00:00Z'),

  -- 5: OPI Lincoln Park After Dark
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Lincoln Park After Dark' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'OPI') LIMIT 1),
   1, 'Dark Plum', '#3B1F2B', 5, ARRAY['vampy','fall','favorite'], '15ml',
   'Almost-black plum, gorgeous in low light.',
   '2025-12-18', '2026-01-02T16:00:00Z', '2026-01-02T16:00:00Z'),

  -- 6: Cirque Colors Lullaby
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Lullaby' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Cirque Colors') LIMIT 1),
   1, 'Periwinkle', '#B4A7D6', 4, ARRAY['indie','spring'], '12.5ml',
   'Dreamy periwinkle cream, very smooth formula.',
   '2025-12-22', '2026-01-05T08:00:00Z', '2026-01-05T08:00:00Z'),

  -- 7: Holo Taco Scattered Holo Taco
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Scattered Holo Taco' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Holo Taco') LIMIT 1),
   1, 'Silver', '#C0C0C0', 5, ARRAY['topper','indie','holographic'], '12ml',
   'Adds scattered holo to any base color. Life-changing topper.',
   '2025-12-25', '2026-01-08T13:00:00Z', '2026-01-08T13:00:00Z'),

  -- 8: Essie Wicked
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Wicked' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Essie') LIMIT 1),
   1, 'Dark Red', '#4A0000', 3, ARRAY['fall','vampy'], '13.5ml',
   'Streaky first coat, needs 3 coats.',
   '2026-01-10', '2026-01-10T10:00:00Z', '2026-01-10T10:00:00Z'),

  -- 9: ILNP Cygnus Loop
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Cygnus Loop' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'ILNP') LIMIT 1),
   1, 'Multichrome', '#4B0082', 5, ARRAY['indie','favorite','special'], '12ml',
   'Shifts from purple to copper to green.',
   '2026-01-15', '2026-01-15T15:00:00Z', '2026-01-15T15:00:00Z'),

  -- 10: OPI Funny Bunny
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Funny Bunny' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'OPI') LIMIT 1),
   1, 'White', '#F5F0EB', 4, ARRAY['everyday','classic'], '15ml',
   'Perfect sheer white for French tips or on its own.',
   '2026-01-20', '2026-01-20T12:00:00Z', '2026-01-20T12:00:00Z'),

  -- 11: China Glaze Ruby Pumps
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Ruby Pumps' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'China Glaze') LIMIT 1),
   1, 'Red Glitter', '#9B111E', 5, ARRAY['holiday','glitter','favorite'], '14ml',
   'Iconic ruby red glitter. Like Dorothy''s slippers in a bottle.',
   '2026-01-22', '2026-01-22T10:00:00Z', '2026-01-22T10:00:00Z'),

  -- 12: Sally Hansen Black Out
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Black Out' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Sally Hansen') LIMIT 1),
   1, 'Black', '#0A0A0A', 4, ARRAY['classic','staple'], '9.17ml',
   'Good drugstore black. One coat formula.',
   '2026-01-23', '2026-01-23T11:00:00Z', '2026-01-23T11:00:00Z'),

  -- 13: Holo Taco One Coat Black
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'One Coat Black' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Holo Taco') LIMIT 1),
   1, 'Black', '#050505', 5, ARRAY['indie','staple','favorite'], '12ml',
   'True one coat black. Best black I''ve ever used.',
   '2026-01-25', '2026-01-25T14:00:00Z', '2026-01-25T14:00:00Z'),

  -- 14: Orly Seize the Day
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Seize the Day' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Orly') LIMIT 1),
   1, 'Coral Shimmer', '#E8734A', 3, ARRAY['summer','shimmer'], '18ml',
   'Pretty coral with subtle shimmer. Chips easily.',
   '2026-01-26', '2026-01-26T09:00:00Z', '2026-01-26T09:00:00Z'),

  -- 15: Zoya Pixie Dust Lux
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Pixie Dust Lux' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Zoya') LIMIT 1),
   1, 'Purple Matte', '#7B3F8C', 4, ARRAY['textured','special'], '15ml',
   'Textured matte finish with sparkle. No top coat needed.',
   '2026-01-28', '2026-01-28T16:00:00Z', '2026-01-28T16:00:00Z'),

  -- 16: OPI Do You Lilac It?
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Do You Lilac It?' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'OPI') LIMIT 1),
   1, 'Lilac', '#C8A2C8', 4, ARRAY['spring','pastel'], '15ml',
   'Classic springtime lilac cream. Two coats.',
   '2026-01-30', '2026-01-30T10:00:00Z', '2026-01-30T10:00:00Z'),

  -- 17: Essie Mint Candy Apple
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Mint Candy Apple' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Essie') LIMIT 1),
   1, 'Mint Green', '#98FF98', 5, ARRAY['spring','pastel','favorite'], '13.5ml',
   'Iconic mint green. Perfect for spring and summer.',
   '2026-02-01', '2026-02-01T12:00:00Z', '2026-02-01T12:00:00Z'),

  -- 18: ILNP Eclipse
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Eclipse' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'ILNP') LIMIT 1),
   1, 'Purple-Red Shift', '#2E0854', 5, ARRAY['indie','special','multichrome'], '12ml',
   'Incredible red-to-green shift. Best multichrome in my collection.',
   '2026-02-03', '2026-02-03T15:00:00Z', '2026-02-03T15:00:00Z'),

  -- 19: Butter London Teddy Girl
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Teddy Girl' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'Butter London') LIMIT 1),
   1, 'Nude Pink', '#D4A0A0', 3, ARRAY['everyday','nude'], '11ml',
   'Nice nude-pink, but slightly thick formula.',
   '2026-02-05', '2026-02-05T11:00:00Z', '2026-02-05T11:00:00Z'),

  -- 20: China Glaze Fairy Dust
  (1,
   (SELECT shade_id FROM shade WHERE shade_name_canonical = 'Fairy Dust' AND brand_id = (SELECT brand_id FROM brand WHERE name_canonical = 'China Glaze') LIMIT 1),
   1, 'Iridescent Glitter', '#F0E6FF', 4, ARRAY['topper','glitter','holiday'], '14ml',
   'Iridescent micro-glitter topper. Adds magic to everything.',
   '2026-02-06', '2026-02-06T13:00:00Z', '2026-02-06T13:00:00Z');

COMMIT;
