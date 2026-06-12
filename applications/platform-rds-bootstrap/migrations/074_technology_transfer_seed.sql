-- =============================================================================
-- Migration 074 — technology_transfer_seed
--
-- "One layer down" transferability seed for the Ontology Grounding feature
-- (spec: 2026-06-12-ontology-grounding-design §A1–A2).
--
-- Adds the missing AI-platform entities required to compute cross-technology
-- transfer groups (chatgpt, codex, openai_gpt, amazon_titan, claude_code,
-- openai, aws), seeds prose aliases for each, and wires the technology_
-- relationships graph (part_of / runs_on / related_to) so the
-- TechnologyOntologyRepository.loadTransferGroups() reader can compute
-- connected components.
--
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING; relationships use the
-- (from_id, to_id, kind) PRIMARY KEY conflict target. UUIDs are never hard-coded;
-- ids are always resolved via canonical_name joins. Safe to re-run.
-- =============================================================================

BEGIN;

-- ── 1. Missing entities ───────────────────────────────────────────────────────
-- anthropic_claude, aws_bedrock, aws_vpc already exist (035). Insert only the
-- entities that are not yet present.

INSERT INTO technology_ontology
    (canonical_name, display_name, category, curation_level, source, is_active)
VALUES
    ('openai',       'OpenAI',         'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('chatgpt',      'ChatGPT',        'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('codex',        'OpenAI Codex',   'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('openai_gpt',   'GPT',            'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('amazon_titan', 'Amazon Titan',   'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('claude_code',  'Claude Code',    'ai_platform',   'curated', 'transfer-seed', TRUE),
    ('aws',          'Amazon Web Services', 'cloud_compute', 'curated', 'transfer-seed', TRUE)
ON CONFLICT (canonical_name) DO NOTHING;

-- ── 2. Aliases ────────────────────────────────────────────────────────────────
-- prose_safe=false: these are brand names / product names that resolve cleanly
-- via structured extraction; they should not participate in the free-form prose
-- substring scanner.

INSERT INTO technology_aliases (alias, technology_id, source, prose_safe)
SELECT a.alias, o.id, 'transfer-seed', FALSE
FROM (VALUES
    -- openai
    ('openai',          'openai'),
    -- chatgpt
    ('chatgpt',         'chatgpt'),
    ('chat gpt',        'chatgpt'),
    -- codex
    ('codex',           'codex'),
    -- openai_gpt
    ('gpt',             'openai_gpt'),
    ('gpt-4',           'openai_gpt'),
    ('gpt-4o',          'openai_gpt'),
    ('openai gpt',      'openai_gpt'),
    -- amazon_titan
    ('titan',           'amazon_titan'),
    ('amazon titan',    'amazon_titan'),
    -- claude_code
    ('claude code',     'claude_code'),
    -- aws
    ('aws',             'aws'),
    ('amazon web services', 'aws')
) AS a(alias, canon)
JOIN technology_ontology o ON o.canonical_name = a.canon
ON CONFLICT (alias) DO NOTHING;

-- ── 3. Relationships ──────────────────────────────────────────────────────────
-- Pattern: INSERT ... SELECT a.id, b.id, '<kind>'
--           FROM technology_ontology a JOIN technology_ontology b ON TRUE
--          WHERE a.canonical_name = $FROM AND b.canonical_name = $TO
--          ON CONFLICT DO NOTHING;
-- This is idempotent and never hard-codes UUIDs.

-- part_of: aws_bedrock → aws
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'part_of'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'aws_bedrock'
  AND b.canonical_name = 'aws'
ON CONFLICT DO NOTHING;

-- part_of: aws_vpc → aws
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'part_of'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'aws_vpc'
  AND b.canonical_name = 'aws'
ON CONFLICT DO NOTHING;

-- runs_on: anthropic_claude → aws_bedrock
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'runs_on'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'anthropic_claude'
  AND b.canonical_name = 'aws_bedrock'
ON CONFLICT DO NOTHING;

-- runs_on: amazon_titan → aws_bedrock
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'runs_on'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'amazon_titan'
  AND b.canonical_name = 'aws_bedrock'
ON CONFLICT DO NOTHING;

-- runs_on: chatgpt → openai
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'runs_on'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'chatgpt'
  AND b.canonical_name = 'openai'
ON CONFLICT DO NOTHING;

-- runs_on: codex → openai
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'runs_on'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'codex'
  AND b.canonical_name = 'openai'
ON CONFLICT DO NOTHING;

-- runs_on: openai_gpt → openai
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'runs_on'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'openai_gpt'
  AND b.canonical_name = 'openai'
ON CONFLICT DO NOTHING;

-- related_to (undirected — seed BOTH directions): anthropic_claude ↔ openai
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'anthropic_claude'
  AND b.canonical_name = 'openai'
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'openai'
  AND b.canonical_name = 'anthropic_claude'
ON CONFLICT DO NOTHING;

-- related_to (both directions): aws_bedrock ↔ openai
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'aws_bedrock'
  AND b.canonical_name = 'openai'
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'openai'
  AND b.canonical_name = 'aws_bedrock'
ON CONFLICT DO NOTHING;

-- related_to (both directions): anthropic_claude ↔ openai_gpt
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'anthropic_claude'
  AND b.canonical_name = 'openai_gpt'
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'openai_gpt'
  AND b.canonical_name = 'anthropic_claude'
ON CONFLICT DO NOTHING;

-- related_to (both directions): claude_code ↔ codex
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'claude_code'
  AND b.canonical_name = 'codex'
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'codex'
  AND b.canonical_name = 'claude_code'
ON CONFLICT DO NOTHING;

-- related_to (both directions): amazon_titan ↔ openai_gpt
INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'amazon_titan'
  AND b.canonical_name = 'openai_gpt'
ON CONFLICT DO NOTHING;

INSERT INTO technology_relationships (from_id, to_id, kind)
SELECT a.id, b.id, 'related_to'
FROM technology_ontology a
JOIN technology_ontology b ON TRUE
WHERE a.canonical_name = 'openai_gpt'
  AND b.canonical_name = 'amazon_titan'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- Verification
--   SELECT canonical_name, category FROM technology_ontology
--     WHERE source = 'transfer-seed';                           -- expect 7 rows
--   SELECT count(*) FROM technology_relationships;             -- expect >=16
--   SELECT f.canonical_name, t.canonical_name, r.kind
--     FROM technology_relationships r
--     JOIN technology_ontology f ON f.id = r.from_id
--     JOIN technology_ontology t ON t.id = r.to_id
--    ORDER BY r.kind, f.canonical_name;
-- =============================================================================

COMMIT;
