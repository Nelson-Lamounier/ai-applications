# Quickstart: Chunk-Packing

**Date**: 2026-06-19 | **Feature**: 004-chunk-packing

Validation scenarios. See [contracts/packing.md](./contracts/packing.md), [data-model.md](./data-model.md), [research.md](./research.md).

## Prerequisites
- shared + ingestion build clean; dev DB tunnel; Bedrock IRSA (eval/live run).

## Scenario 1 — Off = no-op (SC-005)
```bash
# ENRICH_PACK unset
```
**Expect**: skills + cost identical to today's per-chunk path.

## Scenario 2 — Packing cuts calls (SC-001)
```bash
ENRICH_PACK=1 ENRICH_PACK_SIZE=20
```
**Expect**: model-call count ≈ ⌈chunks / 20⌉ (~3,932 → ~200 on the reference repo).

## Scenario 3 — Attribution holds (SC-004)
- Unit + eval: each chunk in a pack receives ITS own skills; a response missing some keys leaves those chunks for fallback, never mis-mapped.

## Scenario 4 — Pack eval gate (SC-003) — binding
```bash
node applications/ingestion/dist/run-pack-eval.js   # per-chunk vs packed, sweep pack size
```
**Expect**: per-chunk recall ≥ baseline, precision not below, zero cross-chunk misattribution. RED → don't enable / lower pack size.

## Scenario 5 — Budget split (FR-005)
- Unit: a pack over `ENRICH_PACK_MAX_CHARS` splits; a single over-large chunk forms its own call.

## Scenario 6 — Fallback (SC-006)
```bash
ENRICH_PACK=1   # then force a parse failure on a pack
```
**Expect**: affected chunks enriched per-chunk (correct skills), `warn` logged, never zero/mis-mapped.

## Scenario 7 — Cost realised (SC-002)
- Diff cost telemetry for a repo enrich, packed vs the ~$5.90 baseline.
**Expect**: order-of-magnitude drop toward ~$1.50–2.00, measured.
