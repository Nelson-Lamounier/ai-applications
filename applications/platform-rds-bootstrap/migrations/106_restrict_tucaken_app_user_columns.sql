-- 106_restrict_tucaken_app_user_columns.sql
--
-- Defence-in-depth for the subscription tier-change lockdown.
--
-- The low-privilege role `tucaken_app` is what every user-facing /api/admin/*
-- request runs as (via withUser() -> SET LOCAL ROLE tucaken_app, with RLS
-- enforced). Migration 003 granted it table-level UPDATE on ALL TABLES, so RLS
-- isolates which ROW it can touch but not which COLUMNS. That left the tier
-- lockdown resting only on the app layer (no user-facing route writes plan) plus
-- a regression test.
--
-- Verified analysis: every write to users.{plan, subscription_status, stripe_*,
-- trial_started_at, trial_ends_at, role} runs on the SUPERUSER/owner pool
-- (getPool(config) / pool.connect()) - NOT under withUser()/tucaken_app. User
-- provisioning, Stripe billing writes, and soft-delete all run as superuser.
-- The only columns tucaken_app legitimately writes today are profile fields
-- (and even those currently run as superuser). So this change has ZERO
-- behaviour impact; it closes the latent surface where a future accidental
-- withUser() write could mutate a tier.
--
-- Postgres semantics: a table-level UPDATE grant cannot be narrowed by a
-- column-level REVOKE - the two are tracked independently and the effective
-- privilege is their union. To restrict to specific columns we must drop the
-- table-level UPDATE on users and re-grant UPDATE on ONLY the safe columns.
--
-- Idempotent: REVOKE/GRANT are repeatable. Safe under the bootstrap adoption
-- re-run because this migration is numbered AFTER 003 (its broad grant), so the
-- restriction always applies last and wins.

-- Drop the table-wide UPDATE on users (came from 003's GRANT ... ON ALL TABLES).
REVOKE UPDATE ON users FROM tucaken_app;

-- Re-grant UPDATE on ONLY the non-sensitive profile columns tucaken_app may
-- legitimately touch. The tier/subscription/identity-privilege columns
-- (plan, subscription_status, stripe_customer_id, stripe_subscription_id,
-- cancel_at_period_end, current_period_end, trial_started_at, trial_ends_at,
-- role) are intentionally excluded - only the superuser pool writes those.
GRANT UPDATE (full_name, avatar_url, updated_at) ON users TO tucaken_app;
