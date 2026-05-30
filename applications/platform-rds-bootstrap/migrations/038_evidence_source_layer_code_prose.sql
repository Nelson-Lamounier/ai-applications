BEGIN;

ALTER TABLE technology_evidence
    DROP CONSTRAINT IF EXISTS technology_evidence_source_layer_check;

ALTER TABLE technology_evidence
    ADD CONSTRAINT technology_evidence_source_layer_check
    CHECK (source_layer IN ('syft','treesitter','iac','dockerfile','readme','code-prose'));

COMMENT ON CONSTRAINT technology_evidence_source_layer_check ON technology_evidence IS
    'Adds code-prose for F2 code-comment + string-literal prose scanner (2026-05-26 detector-strengthening spec).';

COMMIT;
