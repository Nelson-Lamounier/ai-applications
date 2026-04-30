-- Migration 009: add avatar_url to oauth_connections
--
-- The admin-api GitHub route stores the GitHub account avatar URL returned by
-- the GitHub App installation info API so the frontend can display it without
-- a round-trip to GitHub on every page load.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).

ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;
