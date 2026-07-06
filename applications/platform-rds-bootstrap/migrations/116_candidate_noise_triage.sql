-- 116_candidate_noise_triage.sql
--
-- Deterministic triage of the technology_candidates backlog (2,587
-- unresolved rows on dev). Sampling showed the backlog is dominated by
-- extractor NOISE, not missing technologies: GitHub Actions workflow steps
-- (actions/checkout, local ./.github/actions/*), node: builtins, @types/*
-- typings, and npm transitive utility deps. Two deterministic passes:
--
--   1. ALIAS-RESOLVE: candidates whose normalized name equals an existing
--      alias (with the alias's punctuation collapsed the same way the
--      extractor normalises) are marked 'aliased' with the canonical
--      suggested — these were pure normalisation misses.
--   2. IGNORE: CI workflow steps, local paths, node builtins and typings
--      packages are not technologies a resume could claim — mark 'ignored'.
--
-- The remainder stays unresolved for the review loop. The matching
-- insert-time filter (TechnologyCandidateRepository) stops the same noise
-- classes from re-accumulating.

-- Pass 1 — alias-resolvable candidates.
UPDATE technology_candidates c
SET resolution = 'aliased',
    suggested_canonical = a.technology_id,
    resolved_at = NOW()
FROM technology_aliases a
WHERE c.resolved_at IS NULL
  AND c.normalized_name = regexp_replace(a.alias, '[^a-z0-9]', '', 'g')
  AND length(c.normalized_name) >= 3;

-- Pass 2 — structural noise, never resume-claimable technology.
UPDATE technology_candidates
SET resolution = 'ignored',
    resolved_at = NOW()
WHERE resolved_at IS NULL
  AND (
        ecosystem IN ('github-action', 'github_actions')
     OR raw_name LIKE './%'
     OR raw_name LIKE 'node:%'
     OR raw_name LIKE '@types/%'
  );
