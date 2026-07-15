# lib/grounding

Evidence/retrieval truth-keeping -- verifying that Strategist output is
actually supported by what was retrieved from the user's ingested KB.

## Files

- `path-grounding.ts` -- pure verifier that a cited source-file path actually
  exists in the ingested repositories (catches real-tech / invented-path
  citations).
- `path-grounding-loader.ts` -- I/O loader for the authoritative set of
  ingested `file_path` values, kept separate so `path-grounding.ts` stays
  pure and unit-testable.
- `gap-cause.ts` -- classifies why a JD skill ended up in the research
  `gaps` list (kb_present_not_retrieved, kb_no_evidence, etc).
- `corrective-retrieval.ts` -- CRAG-style corrective pass that acts on the
  gap-cause signal to re-surface evidence the first retrieval missed.
- `kb-stats.ts` -- pure parser of per-passage retrieval-health headers
  (`[Source: x, Cosine: c, Rerank: r]`) into a retrieval snapshot.
- `dedupe-skill-gaps.ts` -- one gap row per real-world skill; merges alias
  and compound duplicates the matcher can emit.
- `evidence-provenance.ts` -- flattens a completed run's retrieval data into
  a queryable per-passage trace (retrieved-but-unused, cited, or demoted).

## Invariant

Every claim the Strategist makes about the user's evidence must be traceable
to something actually retrieved and actually present in the KB -- no cited
path, skill, or number may outrun what retrieval returned.

## Adding a file here

Add to `grounding/` if the file verifies, classifies, or repairs the link
between Strategist output and retrieved evidence. A DB write inside such a
file (e.g. `evidence-provenance.ts` persisting its trace) is incidental to
the invariant, not a reason to place it in `db/`.
