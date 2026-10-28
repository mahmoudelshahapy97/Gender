-- 003_platform_parity.sql
-- What every InsightEye console now shares: an in-app notification inbox, an
-- audit log, and refresh sessions tied to the password they were issued under.

-- A refresh session carries the account's token_version from when it was
-- issued, so a password change or reset retires it even if nobody revoked it.
ALTER TABLE refresh_session ADD COLUMN IF NOT EXISTS token_version INTEGER;

-- Gender keeps its own notification model (002: one row per workspace, read
-- marks per account); it gains a "system" kind for test notifications.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
    CHECK (kind IN ('occupancy_high', 'occupancy_low', 'camera_offline', 'camera_online', 'system'));

-- Who did what, when and from where (backend/app/services/audit_service.py).
-- actor is kept as text so the row survives the account being deleted.
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id       UUID REFERENCES app_user (user_id) ON DELETE SET NULL,
    actor         TEXT,
    workspace_id  UUID REFERENCES workspace (workspace_id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failure')),
    target_type   TEXT,
    target_id     TEXT,
    target_label  TEXT,
    ip            TEXT,
    user_agent    TEXT,
    request_id    TEXT,
    data          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
