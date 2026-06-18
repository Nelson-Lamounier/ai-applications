-- =============================================================================
-- 091_evidence_source_layer_github_sbom.sql
-- =============================================================================
-- Tech-extractor standardisation, slice 5 (FOLLOWUP item 3): add the
-- `github-sbom` source layer so the GitHub dependency-graph SBOM can be
-- persisted as a cross-check/fallback to the Syft dependency lane.
--
-- GitHub's SBOM is authoritative for declared dependencies (and already carries
-- a purl per package) but does not resolve transitive deps or version ranges
-- and is not file-cited — hence a distinct, slightly-lower-confidence lane
-- rather than reusing `syft`. Confidence is set in code (CONFIDENCE_BY_LAYER).
--
-- Idempotent (DROP CONSTRAINT IF EXISTS + re-ADD); safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE technology_evidence
    DROP CONSTRAINT IF EXISTS technology_evidence_source_layer_check;

ALTER TABLE technology_evidence
    ADD CONSTRAINT technology_evidence_source_layer_check
    CHECK (source_layer IN
        ('syft','treesitter','iac','dockerfile','readme','code-prose','github-sbom'));

COMMENT ON CONSTRAINT technology_evidence_source_layer_check ON technology_evidence IS
    'Adds github-sbom for the GitHub dependency-graph SBOM cross-check/fallback lane (FOLLOWUP item 3, slice 5).';

COMMIT;
