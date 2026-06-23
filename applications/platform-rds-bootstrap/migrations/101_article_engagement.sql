-- 101_article_engagement.sql
--
-- Article engagement (likes + comments) for the public portfolio site.
-- Replaces the legacy DynamoDB single-table engagement entities
-- (frontend-portfolio: dynamodb-engagement.ts) so the portfolio can become a
-- pure consumer of the in-cluster public-api BFF with zero direct DynamoDB
-- access. Read paths (articles, chat, resume) already moved to public-api;
-- this closes the last gap (frontend-portfolio#6, ai-applications#338).
--
-- Engagement is keyed by article_slug (TEXT), NOT a FK to articles(slug):
-- the portfolio also serves file-based articles that have no RDS row, and we
-- want like/comment to work for any slug. Counts are derived with COUNT(*)
-- rather than a denormalised counter, so they can never drift.
--
-- These tables are PUBLIC by slug (no per-user ownership), so — like the
-- `articles` table — they carry NO row-level security. Likes dedupe per
-- browser session; comments default to 'pending' moderation.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; GRANTs are idempotent.

BEGIN;

-- One like per (article, browser session). Toggle = delete-or-insert.
CREATE TABLE IF NOT EXISTS article_likes (
    article_slug TEXT        NOT NULL,
    session_id   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (article_slug, session_id)
);

CREATE INDEX IF NOT EXISTS idx_article_likes_slug
    ON article_likes (article_slug);

-- Comments with moderation lifecycle. email/ip_address are never exposed
-- on the public read path.
CREATE TABLE IF NOT EXISTS article_comments (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    article_slug TEXT        NOT NULL,
    name         TEXT        NOT NULL,
    email        TEXT        NOT NULL,
    body         TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
    ip_address   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public read: approved comments for a slug, oldest first.
CREATE INDEX IF NOT EXISTS idx_article_comments_slug_status
    ON article_comments (article_slug, status, created_at);

-- Admin moderation queue: pending across all articles, newest first.
CREATE INDEX IF NOT EXISTS idx_article_comments_moderation
    ON article_comments (status, created_at DESC);

-- Rate-limit lookup: recent comments per IP across all articles.
CREATE INDEX IF NOT EXISTS idx_article_comments_ip_recent
    ON article_comments (ip_address, created_at DESC);

-- Application role used by public-api / admin-api at runtime.
GRANT SELECT, INSERT, DELETE ON article_likes    TO tucaken_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON article_comments TO tucaken_app;

COMMIT;
