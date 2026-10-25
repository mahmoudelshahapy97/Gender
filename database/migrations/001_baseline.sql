-- ---------------------------------------------------------------------------
-- 001_baseline — the schema at the first release (a copy of schema.sql then).
--
-- On a fresh volume schema.sql has already created all of this, so the file
-- is a no-op there; it exists so every later migration has a predecessor and
-- a database restored without the init script can be brought up to date.
-- The runner wraps it in a transaction, so the BEGIN/COMMIT are left out.
-- Never edit it: add 002_*.sql instead.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Extensions.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older servers; on PG13+ it is built
-- in. Creating it anyway keeps this file portable across both.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- workspace — a partition of the data: its cameras and everything they count
--
-- Users see the workspaces they are members of (workspace_member, below);
-- admins see all of them. The account roles stay global. "Default" has a
-- fixed id so seed data and tools can name it; the api never deletes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace (
    workspace_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID,                     -- app_user; FK added after that table
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name ON workspace (lower(name));

INSERT INTO workspace (workspace_id, name, description)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default',
        'Holds every camera not placed in another workspace.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- camera — one watched RTSP source
--
-- location / area / building / floor_level / zone are the InsightEye location
-- hierarchy (stream_results carried the same five columns). The analytics
-- filter and group by them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera (
    camera_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Defaults to Default for hand-written inserts; the api always names it.
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- rtsp:// URL, or a local video file path when exercising the pipeline
    -- without hardware.
    rtsp_url    TEXT NOT NULL,
    location    TEXT,
    area        TEXT,
    building    TEXT,
    floor_level TEXT,
    zone        TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Optional region of interest: [[x, y], ...] in pixel coordinates. Only
    -- people whose box centre is inside it are counted.
    roi         JSONB,

    -- Per-camera overrides of the counting thresholds, e.g.
    -- {"snapshot_interval_s": 30}. An absent key means "inherit the global
    -- .env value", which is a different thing from 0.
    settings    JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Names are unique within a workspace.
    CONSTRAINT camera_workspace_name_key UNIQUE (workspace_id, name)
);

-- Partial index: startup only ever asks for the enabled rows.
CREATE INDEX IF NOT EXISTS idx_camera_enabled ON camera (enabled) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_camera_workspace ON camera (workspace_id);

-- ---------------------------------------------------------------------------
-- occupancy_snapshot — who was in view at one moment
--
-- Written every SNAPSHOT_INTERVAL_S per running camera. The successor of
-- InsightEye's stream_results.person_count / male_count / female_count, with
-- two differences: child is counted instead of dropped, and the gender of each
-- person comes from their tracked label (votes over many frames) rather than
-- from one frame's boxes. People whose label has not settled yet are
-- unknown_count, so the four parts always add up to person_count.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS occupancy_snapshot (
    snapshot_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id      UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    -- Always the camera's: set by trg_snapshot_workspace when left out.
    workspace_id   UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_count   INTEGER NOT NULL DEFAULT 0,
    male_count     INTEGER NOT NULL DEFAULT 0,
    female_count   INTEGER NOT NULL DEFAULT 0,
    child_count    INTEGER NOT NULL DEFAULT 0,
    unknown_count  INTEGER NOT NULL DEFAULT 0,
    frame_jpeg     BYTEA,                    -- annotated frame (fallback when MinIO is down)
    frame_key      TEXT,                     -- the frame in MinIO: snapshots/<camera>/<snapshot>.jpg
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT occupancy_counts_check CHECK (
        person_count >= 0 AND male_count >= 0 AND female_count >= 0
        AND child_count >= 0 AND unknown_count >= 0),
    CONSTRAINT occupancy_parts_check CHECK (
        male_count + female_count + child_count + unknown_count = person_count)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_workspace_time
    ON occupancy_snapshot (workspace_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshot_camera_time
    ON occupancy_snapshot (camera_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- visit — one person, from the first frame they were tracked to the last
--
-- Written when a track has been gone longer than the tracker keeps it. This is
-- what "how many women came in today" is answered from: one row per person,
-- not one per frame they stood in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visit (
    visit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id     UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    -- Always the camera's: set by trg_visit_workspace when left out.
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    track_key     TEXT NOT NULL,
    gender        TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (gender IN ('male', 'female', 'child', 'unknown')),
    -- Share of the votes the winning label got, 0..1.
    confidence    REAL,
    -- Confidence-weighted votes per label, e.g. {"male": 4.2, "female": 0.4}.
    votes         JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen    TIMESTAMPTZ NOT NULL,
    last_seen     TIMESTAMPTZ NOT NULL,
    dwell_s       REAL NOT NULL DEFAULT 0 CHECK (dwell_s >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Track ids restart with the worker, so the id alone is not unique; with
    -- its start time it is, and a replayed write cannot count a person twice.
    UNIQUE (camera_id, track_key, first_seen)
);

CREATE INDEX IF NOT EXISTS idx_visit_workspace_time ON visit (workspace_id, first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_visit_camera_time    ON visit (camera_id, first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_visit_gender         ON visit (gender);

-- ---------------------------------------------------------------------------
-- app_user — an operator console account
--
-- Three roles, in ascending order of what they may do:
--   viewer    read everything: dashboard, analytics, visits, snapshots
--   operator  start and stop camera workers
--   admin     register and delete cameras, and manage accounts and workspaces
--
-- There is no public signup. The API creates the first admin at startup from
-- BOOTSTRAP_ADMIN_* if this table is empty; every later account is made by an
-- admin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT,

    -- Argon2, produced by passlib in app/core/security.py. Never a plain digest.
    password_hash TEXT NOT NULL,

    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'operator', 'viewer')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Bumped on "log out everywhere", password change and deactivation. Every
    -- access token carries the value it was minted with, and a mismatch is a
    -- 401.
    token_version INTEGER NOT NULL DEFAULT 1,

    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_user_active ON app_user (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- refresh_session — one row per logged-in device
--
-- Keyed by the refresh token's jti. Refresh rotates: spending a refresh token
-- revokes its row and issues a new one, and a revoked jti presented again is
-- refused.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_session (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    jti         UUID NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_session (user_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- password_otp — a "forgot your password?" code mailed to the account
--
-- At most one live code per account. Only an HMAC of the code is stored; it
-- expires after OTP_TTL_SECONDS and dies after OTP_MAX_ATTEMPTS wrong guesses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_otp (
    user_id       UUID PRIMARY KEY REFERENCES app_user (user_id) ON DELETE CASCADE,
    otp_hash      TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- workspace_member — who may see a workspace
--
-- Admins see every workspace without a row here. A new account joins the
-- workspaces it is created with, or Default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member (user_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_created_by_fkey') THEN
        ALTER TABLE workspace
            ADD CONSTRAINT workspace_created_by_fkey
            FOREIGN KEY (created_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
    END IF;
END $$;

-- Snapshots and visits take their camera's workspace, so the workers never
-- have to know about workspaces and the two can never disagree.
CREATE OR REPLACE FUNCTION gd_inherit_workspace() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT c.workspace_id INTO NEW.workspace_id FROM camera c WHERE c.camera_id = NEW.camera_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_snapshot_workspace
    BEFORE INSERT ON occupancy_snapshot
    FOR EACH ROW EXECUTE FUNCTION gd_inherit_workspace();
CREATE OR REPLACE TRIGGER trg_visit_workspace
    BEFORE INSERT ON visit
    FOR EACH ROW EXECUTE FUNCTION gd_inherit_workspace();

