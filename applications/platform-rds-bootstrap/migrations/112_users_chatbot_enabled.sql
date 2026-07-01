-- 112_users_chatbot_enabled.sql -- per-user chatbot feature flag. Idempotent.
--
-- Gates the chatbot lifecycle feature. Stored on the portfolio owner's record;
-- the admin-api settings endpoint (requireAdminGroup) reads/writes it, and the
-- ingestion pipeline reads it before emitting a lifecycle chunk. Default off.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN NOT NULL DEFAULT false;

COMMIT;
