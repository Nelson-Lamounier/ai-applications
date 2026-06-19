# Data Model: Enrichment Cost Reduction

**Date**: 2026-06-19 | **Feature**: 002-enrichment-cost-reduction

No schema migration. This feature changes how the enricher groups + submits calls; it writes the same `skills` column it does today. The "entities" below are in-memory shapes, not tables.

## In-memory shapes

### FileEnrichUnit (NEW — `groupChunksByFile`)
The grouping a single model call covers.

| Field | Type | Notes |
|---|---|---|
| `filePath` | `string` | the `document_embeddings.file_path` shared by the member chunks |
| `chunks` | `{ id; chunkIndex; content; heading? }[]` | the file's chunks, ordered by `chunk_index` |
| `text` | `string` | concatenated chunk content, capped at the model input budget (split into >1 unit if over) |

**Rules**: a single-chunk file → one unit (degrades to per-chunk cost, never worse). A file over the budget → split into N bounded units (edge case 2).

### SkillAssignment (NEW — `assignSkillsToChunks`)
Maps a unit's extracted skills down to member chunks under the evidence guard.

| Field | Type | Notes |
|---|---|---|
| `chunkId` | `string` | target chunk |
| `skills` | `string[]` | subset of the unit's skills the chunk **evidences** (surface-match OR resolver-near) |

**Rules (FR-004)**: a skill is assigned to a chunk only if evidenced; a unit skill no chunk evidences is dropped. Output skills are a per-chunk subset of the unit skills — never a superset.

### BatchEnrichRecord (NEW — `BedrockBatchEnrich`, ports BedrockBatchClassifier)
One Bedrock batch input line.

| Field | Type | Notes |
|---|---|---|
| `recordId` | `string` | maps back to a `FileEnrichUnit` |
| `modelInput` | `object` | the Anthropic Messages body (same body the inline enrich sends) |

**Rules**: S3 JSONL, size-capped; `recordId→unit` map held for result collection; job submitted once per run (FR-008).

## Unchanged (FR-009)
- `document_embeddings` schema + the `skills` column write path.
- `skill_ontology` / `skill_aliases` vocabulary + `SkillEmbeddingResolver`.
- The `REENRICH_ALL` rollout path (it calls the same enricher, which gains the levers transparently).
