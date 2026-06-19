# Research: Enrichment Cost Reduction

**Date**: 2026-06-19 | **Feature**: 002-enrichment-cost-reduction

All decisions grounded in the live system + existing code; no NEEDS CLARIFICATION remained from the spec.

## D1 — Grouping granularity: per-file (not per-symbol) for v1

- **Decision**: group chunks by `file_path` and make one model call per file (split only when a file's concatenated chunk text exceeds the input budget). Per-symbol is deferred.
- **Rationale**: chunks already carry `file_path` (`document_embeddings.file_path`, set by the chunker). Per-file is the whole ~3.7x lever (1,066 files vs 3,932 chunks on the reference repo) with the simplest, purely deterministic grouping. Per-symbol would need to thread tree-sitter symbol spans into the enrich path — more surface, marginal extra saving over per-file. Ship per-file; revisit per-symbol only if the eval shows file-level granularity costs precision.
- **Alternatives**: per-symbol (more code, deferred); whole-repo single call (blows the input budget, loses all per-chunk evidence).

## D2 — Per-chunk precision guard (FR-004): evidence assignment

- **Decision**: after a file's skills are extracted once, assign a skill to a member chunk only if the chunk **evidences** it. Evidence = the skill's canonical/alias surface form appears in the chunk text (case-insensitive token match) OR the chunk content embeds within the resolver threshold of the skill (reusing the existing `SkillEmbeddingResolver`, threshold 0.65). A skill the file has but no chunk evidences is dropped (not force-attached).
- **Rationale**: this is the spec's central risk — a big multi-purpose file must NOT smear a skill from one region onto every chunk. Surface-match is cheap + high-precision; the embedding fallback recovers paraphrase. Both reuse machinery already in the enrich path, so no new model calls.
- **Alternatives**: attach all file skills to all chunks (violates FR-004); re-call the model per chunk to confirm (defeats the cost saving).

## D3 — Batch lever: port `BedrockBatchClassifier`

- **Decision**: implement the batch submission by porting the existing `BedrockBatchClassifier` (ontology-importer) pattern into a shared `BedrockBatchEnrich`: write per-file enrich requests as S3 JSONL → `CreateModelInvocationJob` → poll `GetModelInvocationJob` → read output JSONL → map `recordId` back to file. Bedrock batch bills ~50% of on-demand.
- **Rationale**: the importer already solved S3 JSONL + job submission + polling + `recordId` mapping + jobName coercion for Anthropic Messages bodies — the enrich body is the same shape. Reuse beats rewrite and inherits its tests.
- **Alternatives**: write batch from scratch (duplicate, risk); skip batch and ship only per-file (leaves ~50% on the table — keep as the independent second increment).

## D4 — Opt-in + fail-safe (FR-006/007)

- **Decision**: two env switches — `ENRICH_PER_FILE=1` (granularity) and `ENRICH_BATCH=1` (batch). Both default off → today's per-chunk inline path runs byte-for-byte. Any failure in grouping/batch (job error, timeout, malformed output) falls back to the per-chunk inline enrich for the affected units, logs a `warn`, and the run still completes with correct skills.
- **Rationale**: lets the cost change ship dark, roll out per-run, and never regress correctness. Mirrors the enricher's existing fail-open posture (resolveSkill catch).
- **Alternatives**: a global config flip (no gradual rollout); hard-fail on batch error (violates FR-007).

## D5 — Eval is the gate (FR-005, Constitution VI)

- **Decision**: `run-enrich-eval.ts` takes a labelled sample of chunks, enriches each both ways (per-chunk baseline vs per-file+assign), and reports per-chunk skill **recall** (did per-file keep the baseline's skills?) and **precision** (did per-file add a skill the chunk doesn't evidence?). Merge gate: recall ≥ baseline, precision not below baseline. No reliance on the cheap path until this passes — same discipline as the SC-002 resolution eval already run on dev.
- **Rationale**: this is a behaviour-adjacent cost change; the only safe proof is measurement on labelled data, per the constitution's "no prompt/workflow change ships without its eval".
- **Alternatives**: trust-by-inspection (rejected — the constitution forbids it for LLM workflow changes).

## D6 — Idempotency + no double-bill (FR-008)

- **Decision**: keep the existing per-chunk write/skip semantics. A batch job is submitted once per run; on resume, a chunk already `enrichment_status='ok'` for this run is not re-billed. Batch S3 keys are run-scoped and cleaned up.
- **Rationale**: re-enrich must stay cheap + safe to re-run (it already is for the per-chunk path); batch must not re-submit completed units.

## D7 — Cost baseline (verified, for SC-002)

- **Decision**: baseline = ~$5.46 per large-repo enrich, ~1,066 files vs 3,932 chunks, ~12k corpus calls — measured on the live dev system (cost-record telemetry + chunk/file counts via `document_embeddings`). Used only as the comparison point; the eval + a live cost-record diff confirm the realised saving.
- **Rationale**: Constitution III — no asserted infra/cost numbers; these are measured.
