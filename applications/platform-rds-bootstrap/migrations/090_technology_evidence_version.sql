-- =============================================================================
-- 090_technology_evidence_version.sql
-- =============================================================================
-- Tech-extractor standardisation, slice 3 (FOLLOWUP item 3): capture package
-- VERSION at the Syft lane. Syft already emits a version per artifact in its
-- `syft-json` output; the parser previously discarded it. With a version, the
-- dependency lane's purl becomes fully qualified (`pkg:npm/name@version`),
-- which is what makes the CycloneDX export (slice 4) genuinely useful.
--
-- Adds a NULLABLE `version TEXT` column. Only the Syft lane populates it; the
-- detection lanes (treesitter/iac/dockerfile/readme/code-prose) leave it NULL.
-- The companion `purl` column (migration 089) is now written on INSERT by
-- TechnologyEvidenceRepository via the canonical toPurl(), incorporating this
-- version when present.
--
-- Additive + idempotent (`ADD COLUMN IF NOT EXISTS`); safe to re-run, reversed
-- by dropping the column. No backfill — version is unknowable for already-stored
-- rows; they pick it up on the next ordinary re-extract.
-- =============================================================================

ALTER TABLE technology_evidence
    ADD COLUMN IF NOT EXISTS version TEXT;
