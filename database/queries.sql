-- ---------------------------------------------------------------------------
-- InsightEye — Gender Analytics : reference queries
--
-- Documentation, not migration. Each query is what an endpoint or service
-- runs (named above it), written with literal values instead of the asyncpg
-- $n parameters so it can be pasted into psql while debugging:
--
--   docker compose exec postgres psql -U gender -d gender_db
--
-- The api builds its WHERE clauses with app/services/filters.py, which adds
-- the date range (as whole days in the viewer's timezone), camera ids and the
-- five location levels to every one of these.
-- ---------------------------------------------------------------------------

\set ws '''00000000-0000-0000-0000-000000000001'''
\set tz '''Africa/Cairo'''

-- ---------------------------------------------------------------------------
-- 1. GET /analytics/cameras/average-gender?gender=female
--    analytics_service.average_gender_by_camera — InsightEye's per-camera
--    average, from snapshots, plus the unique visitors of that gender.
-- ---------------------------------------------------------------------------
SELECT c.name AS camera_name, c.zone,
       round(AVG(f.female_count), 2) AS avg_count,
       MAX(f.female_count) AS max_count, MIN(f.female_count) AS min_count,
       COUNT(*) AS sample_size,
       (SELECT COUNT(*) FROM visit v
        WHERE v.camera_id = c.camera_id AND v.gender = 'female'
          AND v.first_seen >= NOW() - INTERVAL '7 days') AS visit_count
FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id
WHERE f.workspace_id = :ws AND f.captured_at >= NOW() - INTERVAL '7 days'
GROUP BY c.camera_id
ORDER BY avg_count DESC;

-- ---------------------------------------------------------------------------
-- 2. GET /analytics/zones/gender-by-weekday?gender=male
--    analytics_service.gender_by_weekday — InsightEye's zone x weekday.
-- ---------------------------------------------------------------------------
SELECT COALESCE(c.zone, 'Unknown') AS zone,
       EXTRACT(DOW FROM f.captured_at AT TIME ZONE :tz)::int AS weekday_num,
       round(AVG(f.male_count), 2) AS avg_count, COUNT(*) AS sample_size
FROM occupancy_snapshot f JOIN camera c ON c.camera_id = f.camera_id
WHERE f.workspace_id = :ws
GROUP BY 1, 2
ORDER BY weekday_num, zone;

-- ---------------------------------------------------------------------------
-- 3. GET /analytics/gender/ratio-trends?interval=day&source=visits
--    analytics_service.ratio_trends — people per day by gender. With
--    source=occupancy the same shape is AVG(male_count) ... over snapshots.
-- ---------------------------------------------------------------------------
SELECT date_trunc('day', f.first_seen AT TIME ZONE :tz) AS period,
       COUNT(*) FILTER (WHERE f.gender = 'male')    AS male,
       COUNT(*) FILTER (WHERE f.gender = 'female')  AS female,
       COUNT(*) FILTER (WHERE f.gender = 'child')   AS child,
       COUNT(*) FILTER (WHERE f.gender = 'unknown') AS unknown,
       COUNT(*) AS total
FROM visit f JOIN camera c ON c.camera_id = f.camera_id
WHERE f.workspace_id = :ws
GROUP BY 1 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 4. GET /analytics/gender/distribution-by-location?group_by=building
--    analytics_service.distribution_by_location (the visits half).
-- ---------------------------------------------------------------------------
SELECT COALESCE(c.building, 'Unknown') AS grp,
       COUNT(*) FILTER (WHERE f.gender = 'male')   AS male,
       COUNT(*) FILTER (WHERE f.gender = 'female') AS female,
       COUNT(*) FILTER (WHERE f.gender = 'child')  AS child,
       COUNT(*) AS total,
       round(AVG(f.dwell_s)::numeric, 1) AS avg_dwell_s
FROM visit f JOIN camera c ON c.camera_id = f.camera_id
WHERE f.workspace_id = :ws
GROUP BY 1 ORDER BY total DESC;

-- ---------------------------------------------------------------------------
-- 5. GET /analytics/gender/peak-hours
--    analytics_service.peak_hours (the visits half): arrivals per local hour.
-- ---------------------------------------------------------------------------
SELECT EXTRACT(HOUR FROM f.first_seen AT TIME ZONE :tz)::int AS hour,
       COUNT(*) FILTER (WHERE f.gender = 'male')   AS male,
       COUNT(*) FILTER (WHERE f.gender = 'female') AS female,
       COUNT(*) FILTER (WHERE f.gender = 'child')  AS child
FROM visit f JOIN camera c ON c.camera_id = f.camera_id
WHERE f.workspace_id = :ws
GROUP BY 1 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 6. GET /analytics/summary — "in view now": each camera's newest snapshot
--    from the last 10 minutes, summed.
-- ---------------------------------------------------------------------------
SELECT COALESCE(SUM(person_count), 0) AS total, COALESCE(SUM(male_count), 0) AS male,
       COALESCE(SUM(female_count), 0) AS female, COALESCE(SUM(child_count), 0) AS child,
       COUNT(*) AS cameras, MAX(captured_at) AS as_of
FROM (
    SELECT DISTINCT ON (f.camera_id) f.*
    FROM occupancy_snapshot f
    WHERE f.workspace_id = :ws AND f.captured_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY f.camera_id, f.captured_at DESC
) latest;

-- ---------------------------------------------------------------------------
-- 7. Health checks
-- ---------------------------------------------------------------------------

-- Share of visits whose label never settled. High values mean gender.pt
-- rarely sees these people well enough: lower GENDER_MIN_VOTES, or check the
-- camera angle.
SELECT c.name, COUNT(*) AS visits,
       round(100.0 * COUNT(*) FILTER (WHERE f.gender = 'unknown') / COUNT(*), 1) AS unknown_pct
FROM visit f JOIN camera c ON c.camera_id = f.camera_id
GROUP BY c.name ORDER BY unknown_pct DESC;

-- Very short visits in bulk usually mean tracks splitting (one person, many
-- ids): raise VISIT_GAP_SECONDS, or check the frame rate.
SELECT c.name, COUNT(*) FILTER (WHERE f.dwell_s < 5) AS under_5s, COUNT(*) AS visits
FROM visit f JOIN camera c ON c.camera_id = f.camera_id
GROUP BY c.name;

-- Snapshot frames still held, and how much room they take.
SELECT COUNT(*) FILTER (WHERE frame_key IS NOT NULL) AS frames_in_minio,
       COUNT(*) FILTER (WHERE frame_jpeg IS NOT NULL) AS frames_in_postgres,
       pg_size_pretty(COALESCE(SUM(octet_length(frame_jpeg)), 0)) AS postgres_bytes
FROM occupancy_snapshot;
