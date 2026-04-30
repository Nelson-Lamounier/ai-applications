-- =============================================================================
-- Migration 006 — User roles
--
-- Adds a role column to users so the application can distinguish SaaS end
-- users from admin/staff accounts without a separate table.
--
-- Enforcement model:
--   - Cognito Group 'admin' gates access to admin-api at the JWT level.
--     The cognitoJwtAuth middleware rejects any token whose cognito:groups
--     claim does not include 'admin' — no DB lookup required.
--   - users.role mirrors the Cognito group in RDS for DB-level queries
--     (audit logs, support tooling, analytics).
--   - To promote a user: add them to the Cognito 'admin' group AND set
--     users.role = 'admin'. Both steps are needed; either alone is unsafe.
--
-- Values:
--   'user'        — default SaaS end user
--   'admin'       — internal staff / application team (must be in Cognito group)
--   'super_admin' — reserved for future elevated privileges
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin', 'super_admin'));

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role) WHERE role != 'user';

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT id, email, role, auth_provider FROM users ORDER BY role, email;
