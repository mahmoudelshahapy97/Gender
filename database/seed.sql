-- ---------------------------------------------------------------------------
-- InsightEye — Gender Analytics : demo data
--
-- Development only. Deliberately NOT mounted into docker-entrypoint-initdb.d,
-- so a fresh stack comes up empty and nobody ships fabricated footfall to a
-- real deployment. Load it when you want populated charts to work against:
--
--   docker compose exec -T postgres psql -U gender -d gender_db < database/seed.sql
--
-- What it makes, in the Default workspace:
--   * three cameras along InsightEye's location hierarchy (one enabled, on the
--     mediamtx demo stream; two disabled placeholders);
--   * the last 14 days (today included) of occupancy snapshots, every 10
--     minutes from 08:00 to 22:00 UTC, and the visits behind them.
--
-- The numbers come from a fixed random seed, shaped by hour of day (lunch and
-- evening peaks), weekday (busier weekends) and zone (the food court skews
-- female and has more children). Row ids are derived from camera + time, so a
-- second load on the same day changes nothing; a load on a later day adds the
-- new days.
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO camera (camera_id, name, rtsp_url, location, area, building, floor_level, zone, enabled, settings) VALUES
    ('22222222-2222-4222-8222-000000000001', 'Main Entrance',
     'rtsp://mediamtx:8554/gender', 'Cairo HQ', 'North Wing', 'Mall A', 'Ground', 'Entrance',
     TRUE, '{}'::jsonb),
    ('22222222-2222-4222-8222-000000000002', 'Food Court',
     'rtsp://mediamtx:8554/gender', 'Cairo HQ', 'North Wing', 'Mall A', 'Level 2', 'Food Court',
     FALSE, '{"snapshot_interval_s": 120}'::jsonb),
    ('22222222-2222-4222-8222-000000000003', 'Electronics Aisle',
     'rtsp://mediamtx:8554/gender', 'Cairo HQ', 'South Wing', 'Mall B', 'Ground', 'Electronics',
     FALSE, '{}'::jsonb)
ON CONFLICT (camera_id) DO NOTHING;

SELECT setseed(0.42);

-- One row per camera per 10-minute slot, with the expected crowd and mix.
CREATE TEMP TABLE seed_slot ON COMMIT DROP AS
SELECT c.camera_id,
       slot_local AT TIME ZONE 'UTC' AS slot,
       -- Expected people in view: base per camera x hour curve x weekday.
       (c.base
         * (0.35 + 0.65 * exp(-((EXTRACT(HOUR FROM slot_local) + EXTRACT(MINUTE FROM slot_local) / 60 - 13) ^ 2) / 6)
                 + 0.55 * exp(-((EXTRACT(HOUR FROM slot_local) + EXTRACT(MINUTE FROM slot_local) / 60 - 19) ^ 2) / 4))
         * CASE WHEN EXTRACT(DOW FROM slot_local) IN (5, 6) THEN 1.35 ELSE 1.0 END)::float8 AS crowd,
       c.p_female,
       c.p_child
FROM (VALUES
        ('22222222-2222-4222-8222-000000000001'::uuid, 6.0, 0.45, 0.08),
        ('22222222-2222-4222-8222-000000000002'::uuid, 9.0, 0.58, 0.16),
        ('22222222-2222-4222-8222-000000000003'::uuid, 4.0, 0.30, 0.05)
     ) AS c(camera_id, base, p_female, p_child)
CROSS JOIN generate_series(
        date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '13 days' + INTERVAL '8 hours',
        date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '21 hours 50 minutes',
        INTERVAL '10 minutes') AS t(slot_local)
WHERE EXTRACT(HOUR FROM slot_local) BETWEEN 8 AND 21
  AND slot_local AT TIME ZONE 'UTC' <= NOW();

-- Occupancy: split the crowd into male / female / child, sometimes one not
-- yet labelled.
INSERT INTO occupancy_snapshot
    (snapshot_id, camera_id, captured_at, person_count, male_count, female_count, child_count, unknown_count)
SELECT md5(camera_id::text || 'snap' || slot::text)::uuid, camera_id, slot,
       m + f + ch + u, m, f, ch, u
FROM (
    SELECT camera_id, slot,
           round(n * (1 - p_female - p_child) * (0.7 + random() * 0.6))::int AS m,
           round(n * p_female * (0.7 + random() * 0.6))::int AS f,
           round(n * p_child * (0.5 + random()))::int AS ch,
           (random() < 0.3)::int AS u
    FROM (SELECT *, crowd * (0.75 + random() * 0.5) AS n FROM seed_slot) x
) y
ON CONFLICT (snapshot_id) DO NOTHING;

-- Visits: about one new person per 10 minutes for every 1.5 people in view,
-- each with a label, a dwell of 20 s to 15 min, and a start inside the slot.
INSERT INTO visit
    (visit_id, camera_id, track_key, gender, confidence, votes, first_seen, last_seen, dwell_s)
SELECT md5(camera_id::text || 'visit' || slot::text || k::text)::uuid,
       camera_id,
       'seed:' || to_char(slot AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI') || ':' || k,
       gender,
       CASE WHEN gender = 'unknown' THEN NULL ELSE round((0.6 + random() * 0.4)::numeric, 3) END,
       CASE WHEN gender = 'unknown' THEN '{}'::jsonb
            ELSE jsonb_build_object(gender, round((1 + random() * 4)::numeric, 2)) END,
       start_at,
       start_at + make_interval(secs => dwell),
       dwell
FROM (
    SELECT camera_id, slot, k,
           slot + make_interval(secs => floor(random() * 600)) AS start_at,
           round((20 + random() ^ 2 * 880)::numeric, 1)::float8 AS dwell,
           CASE WHEN r < 0.05 THEN 'unknown'
                WHEN r < 0.05 + p_child THEN 'child'
                WHEN r < 0.05 + p_child + p_female THEN 'female'
                ELSE 'male' END AS gender
    FROM (
        SELECT s.*, k, random() AS r
        FROM seed_slot s
        CROSS JOIN LATERAL generate_series(
            1, greatest(0, round(s.crowd / 1.5 * (0.6 + random() * 0.8))::int)) AS k
    ) z
) v
WHERE start_at <= NOW()
ON CONFLICT DO NOTHING;

COMMIT;

-- What got loaded:
SELECT c.name,
       (SELECT COUNT(*) FROM occupancy_snapshot s WHERE s.camera_id = c.camera_id) AS snapshots,
       (SELECT COUNT(*) FROM visit v WHERE v.camera_id = c.camera_id) AS visits
FROM camera c
WHERE c.camera_id::text LIKE '22222222-%'
ORDER BY c.name;
