-- M2 success metrics — weekly read (decision D19, #323; roadmap §4 in docs/roadmap-2026-10-to-12.md).
--
-- Read-only: one SELECT inside a READ ONLY transaction, returning one row. Run it weekly against
-- prod (psql or the Azure portal query editor) and paste the row into the sprint notes:
--
--   psql "$DATABASE_URL" -f docs/queries/m2-metrics.sql
--
-- The reporting window is the 7 days ending at `week_end` (default: now). To re-run an earlier
-- week, replace `now()` in `params` with a timestamp, e.g. timestamptz '2026-11-30 00:00+00'.
-- The dupe-warning funnel is browser-only and lives in App Insights (KQL in
-- docs/observability-plan.md, "M2 success metrics"), not here.
--
-- Definitions (columns checked against docs/schema.sql):
--   active user       app_user with any write in the window: an inventory row created or updated
--                     (user_inventory_item.created_at / updated_at), a mani logged
--                     (manicure.created_at) or a CSV import committed
--                     (polish_import_session.committed_at). updated_at only keeps the last write,
--                     so this slightly undercounts users whose only edit was overwritten later.
--   non-default row   an inventory row whose status is not the default 'owned', or that is
--                     marked tried (tried_at IS NOT NULL). "Untried" is derived from tried_at,
--                     so marking tried counts as setting a status.
--   collection row    an inventory row that is not on the wishlist (status <> 'wishlist').
--                     "20 polishes" counts rows (distinct shades), not bottle quantity.
--   active shade      shade.status = 'active' that has not been merged into another shade.

BEGIN TRANSACTION READ ONLY;

WITH params AS (
  SELECT now() AS week_end, now() - interval '7 days' AS week_start
),
active_users AS (
  SELECT i.user_id
  FROM user_inventory_item i, params p
  WHERE i.created_at >= p.week_start AND i.created_at < p.week_end
     OR i.updated_at >= p.week_start AND i.updated_at < p.week_end
  UNION
  SELECT m.user_id
  FROM manicure m, params p
  WHERE m.created_at >= p.week_start AND m.created_at < p.week_end
  UNION
  SELECT s.user_id
  FROM polish_import_session s, params p
  WHERE s.committed_at >= p.week_start AND s.committed_at < p.week_end
),

-- 1. Status adoption: per active user, the share of their inventory rows with a non-default
--    status. A user "adopted" statuses when at least one row is non-default. Target: > 60% of
--    active users.
status_per_user AS (
  SELECT
    a.user_id,
    count(i.inventory_item_id) AS row_count,
    count(i.inventory_item_id) FILTER (WHERE i.status <> 'owned' OR i.tried_at IS NOT NULL) AS non_default_count
  FROM active_users a
  LEFT JOIN user_inventory_item i ON i.user_id = a.user_id
  GROUP BY a.user_id
),
status_adoption AS (
  SELECT
    count(*) AS active_users,
    count(*) FILTER (WHERE non_default_count > 0) AS status_adopters,
    round(avg(non_default_count::numeric / NULLIF(row_count, 0)), 3) AS avg_non_default_share,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY non_default_count::numeric / NULLIF(row_count, 0)
    ) AS median_non_default_share
  FROM status_per_user
),

-- 2. Manis logged per active user per week (logged = manicure.created_at in the window, whatever
--    its worn_on date). Target: >= 1.
manis AS (
  SELECT
    count(*) AS manis_logged,
    count(DISTINCT m.user_id) AS users_logging_manis
  FROM manicure m, params p
  WHERE m.created_at >= p.week_start AND m.created_at < p.week_end
),

-- 3. Time from signup to the 20th collection row, for users who signed up in the last 28 days
--    (a cohort wide enough to have a few users; tighten once traffic grows). via_import = the user
--    had committed a CSV import by then. Target: < 5 min on the import path.
ranked_rows AS (
  SELECT
    i.user_id,
    i.created_at,
    row_number() OVER (PARTITION BY i.user_id ORDER BY i.created_at, i.inventory_item_id) AS n
  FROM user_inventory_item i
  WHERE i.status <> 'wishlist'
),
signup_cohort AS (
  SELECT
    u.user_id,
    u.created_at AS signed_up_at,
    r.created_at AS twentieth_at,
    EXISTS (
      SELECT 1
      FROM polish_import_session s
      WHERE s.user_id = u.user_id
        AND s.committed_at IS NOT NULL
        AND s.committed_at <= r.created_at + interval '1 minute'
    ) AS via_import
  FROM app_user u
  CROSS JOIN params p
  LEFT JOIN ranked_rows r ON r.user_id = u.user_id AND r.n = 20
  WHERE u.created_at >= p.week_end - interval '28 days' AND u.created_at < p.week_end
),
time_to_20 AS (
  SELECT
    count(*) AS cohort_signups,
    count(twentieth_at) AS cohort_reached_20,
    round((percentile_cont(0.5) WITHIN GROUP (
      ORDER BY extract(epoch FROM twentieth_at - signed_up_at)
    ) / 60)::numeric, 1) AS median_minutes_to_20,
    round((percentile_cont(0.5) WITHIN GROUP (
      ORDER BY extract(epoch FROM twentieth_at - signed_up_at)
    ) FILTER (WHERE via_import) / 60)::numeric, 1) AS median_minutes_to_20_via_import,
    count(twentieth_at) FILTER (WHERE via_import) AS cohort_reached_20_via_import
  FROM signup_cohort
),

-- 4. Active catalog shades, and how many became active this week (indie sources target: +10k
--    by 19 Dec; compare with the 2026-10-17 baseline). created_at approximates "became active":
--    an approved user submission keeps its original created_at.
catalog AS (
  SELECT
    count(*) AS active_shades,
    count(*) FILTER (WHERE s.created_at >= p.week_start AND s.created_at < p.week_end) AS active_shades_added
  FROM shade s, params p
  WHERE s.status = 'active' AND s.merged_into_shade_id IS NULL
)

SELECT
  p.week_start,
  p.week_end,
  sa.active_users,
  sa.status_adopters,
  round(sa.status_adopters::numeric / NULLIF(sa.active_users, 0), 3) AS status_adoption_share,
  sa.avg_non_default_share,
  round(sa.median_non_default_share::numeric, 3) AS median_non_default_share,
  m.manis_logged,
  m.users_logging_manis,
  round(m.manis_logged::numeric / NULLIF(sa.active_users, 0), 2) AS manis_per_active_user,
  t.cohort_signups,
  t.cohort_reached_20,
  t.median_minutes_to_20,
  t.cohort_reached_20_via_import,
  t.median_minutes_to_20_via_import,
  c.active_shades,
  c.active_shades_added
FROM params p
CROSS JOIN status_adoption sa
CROSS JOIN manis m
CROSS JOIN time_to_20 t
CROSS JOIN catalog c;

COMMIT;
