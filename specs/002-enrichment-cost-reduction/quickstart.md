# Quickstart: Enrichment Cost Reduction

**Date**: 2026-06-19 | **Feature**: 002-enrichment-cost-reduction

Validation scenarios proving the levers are cost-only + safe. See [contracts/enrichment-levers.md](./contracts/enrichment-levers.md) + [data-model.md](./data-model.md).

## Prerequisites
- shared + ingestion build clean (`npx tsc -b applications/shared applications/ingestion`).
- Dev DB tunnel (pgbouncer) + Bedrock IRSA for the eval/batch runs.

## Scenario 1 — Off = no-op (SC-005)
```bash
# default env: ENRICH_PER_FILE + ENRICH_BATCH unset
# enrich a repo, compare skills to a pre-change run -> identical
```
**Expect**: skills byte-for-byte equal to today's per-chunk path.

## Scenario 2 — Per-file cuts calls (SC-001)
```bash
ENRICH_PER_FILE=1   # one call per file, not per chunk
```
**Expect**: model-call count ≈ distinct-file count (≈1,066 vs 3,932 on the reference repo, ~3.7x fewer).

## Scenario 3 — Precision guard holds (SC-004)
- Unit test `assignSkillsToChunks`: a file skill evidenced by only chunk A is NOT attached to chunk B.
**Expect**: no chunk tagged a skill it doesn't evidence; per-chunk skills ⊆ file skills.

## Scenario 4 — Eval gate (SC-003/SC-004) — the binding check
```bash
node applications/ingestion/dist/run-enrich-eval.js   # labelled sample, both paths
```
**Expect**: recall ≥ per-chunk baseline AND precision ≥ baseline. RED → do not enable the cheap path.

## Scenario 5 — Batch + fallback (SC-006)
```bash
ENRICH_PER_FILE=1 ENRICH_BATCH=1     # cheapest path
# then force a batch job error -> run still completes
```
**Expect**: with batch healthy, ~50% lower per-call rate; with batch forced to fail, every chunk still gets correct skills via inline fallback, `warn` logged (not silent).

## Scenario 6 — Cost realised (SC-002)
- Diff cost-record telemetry for a large-repo enrich, cheap path vs baseline.
**Expect**: order-of-magnitude drop (~$5.46 → ~$0.74), measured (not asserted).

## Switches & infra prerequisites

| Var | Purpose |
|---|---|
| `ENRICH_PER_FILE=1` | per-file granularity (US1) — the ~3.7x lever, no extra infra |
| `ENRICH_PER_FILE_MAX_CHARS` | file-unit input budget (default 12000) |
| `ENRICH_BATCH=1` | Bedrock batch (US3) — the ~50% lever; **requires the infra below** |
| `ENRICH_BATCH_BUCKET` / `ENRICH_BATCH_ROLE_ARN` | S3 bucket for batch JSONL + the Bedrock batch service-role ARN |
| `ENRICH_BATCH_PREFIX` / `_POLL_MS` / `_DEADLINE_MS` | batch S3 prefix + poll cadence + deadline |

**Deferred (operator/infra):**
- **Batch infra** — the S3 bucket + Bedrock batch IAM role are NOT provisioned by
  this feature (CDK change). Until they exist, `ENRICH_BATCH=1` fails closed and
  falls back to inline per-file (still the ~3.7x win, just not the extra ~50%).
- **The eval Job (T013)** + **live cost diff (T019)** run on dev after this
  merges + the ingestion image redeploys.
- **The corpus re-enrich (roadmap #4)** — the operator runs it via the UI with
  `ENRICH_PER_FILE=1` (and `ENRICH_BATCH=1` once infra lands).
