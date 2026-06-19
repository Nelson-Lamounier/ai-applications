# Contract: Enrichment Cost Levers

**Date**: 2026-06-19 | **Feature**: 002-enrichment-cost-reduction

Internal contracts (pure functions + a batch helper + env switches). No external/HTTP surface.

## Env switches (run-level, default OFF)

| Var | Default | Effect |
|---|---|---|
| `ENRICH_PER_FILE` | unset/`0` | `1` → group by file, one call per file, assign by evidence. Off → per-chunk inline (today). |
| `ENRICH_BATCH` | unset/`0` | `1` → submit the (per-file or per-chunk) calls as a Bedrock batch. Off → inline calls (today). |

Both off ⇒ byte-for-byte today's path (SC-005). They compose: `ENRICH_PER_FILE=1 ENRICH_BATCH=1` is the cheapest path.

## `groupChunksByFile(chunks, maxInputChars): FileEnrichUnit[]` (pure)
- One unit per `filePath`; member chunks ordered by `chunkIndex`.
- A file whose concatenated text > `maxInputChars` → split into >1 unit, each ≤ budget.
- Single-chunk file → single-chunk unit (cost ≤ per-chunk).
- Deterministic; no I/O. Unit-tested.

## `assignSkillsToChunks(unit, unitSkills, evidence): SkillAssignment[]` (pure)
- For each member chunk, return only the `unitSkills` the chunk **evidences**:
  - surface-match: a skill's canonical/alias token appears in the chunk content (case-insensitive), OR
  - resolver-near: the chunk embeds within threshold of the skill (injected `evidence` fn reusing `SkillEmbeddingResolver`).
- A unit skill no chunk evidences is dropped (FR-004).
- Per-chunk output ⊆ unit skills (never a superset). Deterministic given `evidence`. Unit-tested.

## `BedrockBatchEnrich.run(units): Map<recordId, EnrichResult>` (ports BedrockBatchClassifier)
- Writes per-unit Messages bodies as S3 JSONL (size-capped) → `CreateModelInvocationJob` → poll `GetModelInvocationJob` → read output JSONL → map `recordId`→unit result.
- **Fail-safe (FR-007)**: any job error/timeout/malformed line → caller falls back to inline per-chunk enrich for the affected units; `warn` logged, never silent, never zero-skill.
- **Idempotent (FR-008)**: one job per run; run-scoped S3 keys; completed units not re-submitted on resume.

## `run-enrich-eval.ts` (the FR-005 gate)
- Input: labelled sample of chunks. Runs per-chunk baseline vs per-file+assign.
- Output: per-chunk skill **recall** (vs baseline) + **precision** (added skills the chunk doesn't evidence).
- **Merge gate**: recall ≥ baseline AND precision ≥ baseline. Cheap path not relied upon until green (same discipline as the SC-002 resolution eval).

## Invariants (unchanged — FR-009)
- `skills` column write path, `document_embeddings` schema.
- `SkillEmbeddingResolver` + vocabulary + `REENRICH_ALL` (gains levers transparently via the shared enricher).
