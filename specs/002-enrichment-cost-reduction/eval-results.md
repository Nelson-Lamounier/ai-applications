# Eval Results: Enrichment Cost Reduction (T013)

**Date**: 2026-06-19 | **Job**: `enrich-eval` on dev | **Sample**: Nelson-Lamounier/tucaken-infra, 100 chunks across 19 files

## Run 1 — per-file granularity (US1) vs per-chunk baseline

| Metric | Value | Gate | Verdict |
|---|---|---|---|
| Recall | **0.118** | ≥ 0.90 | ❌ FAIL |
| Precision | 0.806 | ≥ 0.90 | ❌ FAIL |
| baseline calls | 100 | — | — |
| candidate calls | 32 | — | ~3.1x fewer |
| dropped skills | 778 | — | the problem |
| added skills | 36 | — | minor |

**Verdict: FAIL — per-file granularity is NOT viable for this extraction.**

### Why (root cause)
The per-chunk baseline makes one focused call per chunk and accumulates ~880 skills
across the sample. The per-file path makes ONE call over the whole file
(`max_tokens: 512`) and the model returns only a handful of file-level skills — it
cannot enumerate every skill across 5+ chunks in a single bounded response. So the
**sum of per-chunk extractions >> a single file extraction**: 778 of ~880 baseline
skills are lost (recall 0.118). The surface-match evidence guard compounds it
(short noun-phrase skills rarely appear verbatim in chunk text), but the dominant
loss is the file-level call producing far fewer skills than the per-chunk sum.

This is the eval gate working exactly as intended (Constitution VI): it stopped a
lever that would have silently dropped ~88% of skills — devastating retrieval +
résumé matching — before it was enabled on the corpus.

### Decision
- **`ENRICH_PER_FILE` stays OFF.** The per-file lever is not enabled; it failed the gate.
- The ~3.7x call-reduction is not achievable this way without an unacceptable recall loss.

## Recommended pivot — batch the PER-CHUNK calls (recall-neutral ~50%)
The safe cost lever is **`ENRICH_BATCH` over per-chunk units**: each chunk still gets
its own model call (skills identical to today — recall 1.0, precision 1.0 by
construction), just submitted as one async Bedrock batch job for the ~50% discount.
This delivers a real, safe saving without the recall loss — and needs the batch path
wired into the per-chunk loop (today it only runs under `ENRICH_PER_FILE`).
