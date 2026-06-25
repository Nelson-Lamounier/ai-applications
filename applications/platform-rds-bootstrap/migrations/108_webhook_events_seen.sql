-- 108_webhook_events_seen.sql
-- Idempotency guard + audit trail for Stripe webhook deliveries. Each event id
-- is claimed the first time it is seen (INSERT ... ON CONFLICT DO NOTHING);
-- later retries of the same event are recognised and skipped by the handler.
CREATE TABLE IF NOT EXISTS webhook_events_seen (
  event_id    TEXT        PRIMARY KEY,
  type        TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
