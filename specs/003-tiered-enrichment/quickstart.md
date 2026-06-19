# Quickstart: Tiered Enrichment

**Date**: 2026-06-19 | **Feature**: 003-tiered-enrichment

Validation scenarios proving the cascade is cheaper + quality-equivalent. See [contracts/tier-cascade.md](./contracts/tier-cascade.md), [data-model.md](./data-model.md), [research.md](./research.md).

## Prerequisites
- shared + ingestion build clean; dev DB tunnel; Bedrock IRSA (Tier 3 only).
- `tech_skill_map` migration applied (Tier 1).

## Scenario 1 — Tier 0 MVP: technologies from JOIN (SC-003)
```bash
ENRICH_TIER0=1   # others off
```
**Expect**: every chunk on an evidenced file gets canonical technologies (zero model calls); files without evidence → empty (not hallucinated). `chunks.technologies` goes from 0/12,236 to populated.

## Scenario 2 — Tier 1: deterministic skills (SC-002 start)
```bash
ENRICH_TIER0=1 ENRICH_TIER1=1
```
**Expect**: code chunks whose file evidences a mapped tech get the mapped canonical skill, no model call; chunks with no mapped signal stay residual. Precision guard: no skill the chunk doesn't evidence.

## Scenario 3 — Tier 2: embedding classification (SC-004)
```bash
ENRICH_TIER0=1 ENRICH_TIER1=1 ENRICH_TIER2=1 TIER2_THRESHOLD=<tuned>
```
**Expect**: residual chunks near a label get that canonical skill; below threshold stay residual. No new model call.

## Scenario 4 — per-tier eval gate (SC-004) — binding
```bash
node applications/ingestion/dist/run-enrich-eval.js   # per-tier recall/precision + resolvedBy coverage
```
**Expect**: each enabled tier's recall ≥ per-chunk baseline, precision not below. Coverage shows ≤25% residual reaching Tier 3 (SC-002). RED → don't enable that tier.

## Scenario 5 — Tier 3: batched + deferred residue (SC-006)
```bash
ENRICH_TIER0=1 ENRICH_TIER1=1 ENRICH_TIER2=1 ENRICH_TIER3=1
```
**Expect**: only the residue is submitted as batched Bedrock jobs; sync completes + repo searchable from Tiers 0–2 without waiting; the followup fills residue skills when the batch lands.

## Scenario 6 — dedup cache (SC-007)
**Expect**: two identical-content chunks compute once; the second is a cache hit (`enrich:v1:<user>:<hash>`), no recompute.

## Scenario 7 — cost realised (SC-001)
- Diff cost telemetry for a repo enrich, cascade vs the ~$5.90 baseline.
**Expect**: order-of-magnitude drop toward ~$0.40, measured.

## Verify-don't-bank (FR-011)
- Confirm Bedrock prompt caching availability + min prefix for `claude-haiku-4-5` in eu-west-1 before claiming the caching slice; Tier 0–2 savings stand without it.
