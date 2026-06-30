-- 110_article_destinations.sql
-- Per-site publish targeting for articles. Each article carries the set of
-- public sites it should appear on. Existing rows default to ['portfolio']
-- so current portfolio visibility is preserved. The public-api filters
-- portfolio reads with `destinations @> ARRAY['portfolio']`; the future
-- Tucaken articles surface will filter with `@> ARRAY['tucaken']`.
--
-- Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) per ADR 0009.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS destinations TEXT[] NOT NULL DEFAULT ARRAY['portfolio'];

CREATE INDEX IF NOT EXISTS idx_articles_destinations
  ON articles USING GIN (destinations);
