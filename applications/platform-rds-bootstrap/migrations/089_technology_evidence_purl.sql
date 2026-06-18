-- =============================================================================
-- 089_technology_evidence_purl.sql
-- =============================================================================
-- Tech-extractor standardisation, slice 2 (FOLLOWUP item 3): give every
-- `technology_evidence` row a canonical Package URL (purl) identity so the
-- bespoke evidence model can be exported as a standard CycloneDX 1.6 SBOM and
-- deduped/aggregated across repos on a stable key.
--
-- Adds a NULLABLE `purl TEXT` column + a lookup index, then backfills existing
-- rows. The backfill expression MIRRORS the canonical TypeScript `toPurl()`
-- (applications/shared/src/sbom/purl.ts), which is the source of truth:
--   * ecosystem -> purl type: known purl types pass through (lower-cased);
--     anything else (incl. non-package signals like `aws`/`terraform`, or a
--     NULL ecosystem) falls back to `generic`;
--   * the npm scope `@` is percent-encoded to `%40` in the name;
--   * no version segment — `technology_evidence` does not capture version today
--     (a later slice adds it at the Syft lane, after which new rows carry it).
-- Keep the KNOWN-types list below in sync with `KNOWN_PURL_TYPES` in purl.ts.
--
-- Every statement is additive and idempotent (`IF NOT EXISTS`, backfill guarded
-- by `purl IS NULL`), so this migration is safe to re-run and is reversed by
-- dropping the column/index. New rows get their purl from the extractor going
-- forward (and on the next ordinary re-extract for rows still NULL).
-- =============================================================================

ALTER TABLE technology_evidence
    ADD COLUMN IF NOT EXISTS purl TEXT;

-- Per-repo BOM generation groups by purl within (user_id, repo_full_name).
CREATE INDEX IF NOT EXISTS ix_technology_evidence_purl
    ON technology_evidence (user_id, repo_full_name, purl);

-- One-time backfill of existing rows. Mirrors toPurl() exactly (no version).
UPDATE technology_evidence
   SET purl = 'pkg:'
       || CASE
            WHEN lower(ecosystem) IN (
                'npm','pypi','gem','cargo','golang','maven','nuget','composer',
                'docker','deb','rpm','apk','conan','hex','pub','swift','generic'
            ) THEN lower(ecosystem)
            ELSE 'generic'
          END
       || '/' || replace(raw_name, '@', '%40')
 WHERE purl IS NULL;
