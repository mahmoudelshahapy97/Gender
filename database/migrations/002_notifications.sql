-- 002: notifications -- occupancy alerts and camera health, per workspace.
--
-- One row per event, shared by everyone who can see its workspace; whether a
-- given account has read it is a row in notification_read. app_user gains the
-- opt-in for having them mailed.
--
-- Idempotent like every migration: on a fresh volume schema.sql already made
-- all of this and the file runs as a no-op.

CREATE TABLE IF NOT EXISTS notification (
    notification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    camera_id        UUID REFERENCES camera (camera_id) ON DELETE SET NULL,
    camera_name      TEXT,
    kind             TEXT NOT NULL
                     CHECK (kind IN ('occupancy_high', 'occupancy_low', 'camera_offline', 'camera_online')),
    severity         TEXT NOT NULL DEFAULT 'info'
                     CHECK (severity IN ('info', 'warning', 'critical')),
    title            TEXT NOT NULL,
    message          TEXT NOT NULL,
    details          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_workspace_time
    ON notification (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_camera_time
    ON notification (camera_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_read (
    notification_id  UUID NOT NULL REFERENCES notification (notification_id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, notification_id)
);

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT FALSE;
