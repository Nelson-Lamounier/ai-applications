-- 037_alias_prose_safe.sql
--
-- Adds a `prose_safe` BOOLEAN tag to technology_aliases so the README parser
-- (ReadmeParser v2, tech-extractor) knows which aliases are safe to match in
-- free-form prose vs. which must be confined to structured contexts (imports,
-- manifests, code blocks).
--
-- Rationale: substring-matching aliases against arbitrary English produces
-- surprising false positives (e.g. "go" matches every sentence using the verb;
-- "react" matches every sentence using the verb; "rust" matches sentences about
-- memory safety; "spark" matches metaphors). The ontology's strength — broad
-- alias coverage — becomes a weakness in unstructured prose. The prose_safe
-- tag is the discriminator.
--
-- Values:
--   true   = alias is unambiguous enough to match in prose without context
--            (e.g. 'kubernetes', 'grafana', 'prometheus', 'terraform').
--   false  = alias overlaps with common English or has homonym risk; must
--            only be matched in structured contexts.
--   NULL   = unclassified (the bootstrap state). The bootstrap tagger fills
--            these via a one-shot Bedrock batch.
--
-- Builds on 034_technology_graph.sql (technology_aliases). Expand-only,
-- idempotent (IF NOT EXISTS). No backfill — bootstrap is a separate process.

BEGIN;

ALTER TABLE technology_aliases
    ADD COLUMN IF NOT EXISTS prose_safe BOOLEAN;

COMMENT ON COLUMN technology_aliases.prose_safe IS
    'NULL=unclassified; true=safe to match in free-form prose; false=structured-context only';

-- Index for the prose-extraction hot path: WHERE prose_safe = true.
-- Partial index keeps it small (only the safe-to-match aliases).
CREATE INDEX IF NOT EXISTS idx_technology_aliases_prose_safe
    ON technology_aliases (alias)
 WHERE prose_safe = true;

COMMIT;
