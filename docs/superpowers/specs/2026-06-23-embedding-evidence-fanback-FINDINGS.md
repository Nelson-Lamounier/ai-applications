# Embedding-evidence fan-back — implementation annotation & eval findings

**Date:** 2026-06-23
**Branch / PR:** `feat/embedding-evidence-fanback` / ai-applications **#340** (stacked on #337)
**Status:** **Built, reviewed, eval'd — DOES NOT achieve its goal. Held for review; not recommended for merge as a recall fix.**
**Decision (owner):** Keep the existing **~$7/repo inline per-chunk enrichment** for Premium (already working). The per-file lever + this embedding lane are **shelved**. Premium env stays `{ ENRICH_TIER1: '1' }` (tucaken-app #157) — full per-chunk, correct quality.

---

## 1. What this implementation is

A semantic evidence lane for the per-file enrichment fan-back. Context:

- #337 added **per-file batching** to the deferred enrichment path (`reenrichSkippedChunks`): one LLM call per file instead of per chunk (~45% fewer calls), then fan the file's skills back to its chunks. That fan-back kept a skill on a chunk **only if the skill term surface-matches the chunk text** (`assignSkillsToChunks(unit, skills, () => false)`).
- A live eval showed per-file **recall 0.758** vs a 0.97 gate — surface-match-only drops ~24% of skills.
- **Hypothesis (this work):** the dropped skills are *semantically present but not literally named*, so add a cosine lane — keep a skill when `surfaceMatch OR cosine(skillVector, chunkVector) >= threshold`, using vectors already stored (`skill_ontology.embedding` for the canonical skill, `document_embeddings.embedding` for the chunk). Zero new Bedrock, no new infra.

### Components delivered (all built, tested, reviewed clean)
- `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.ts` — pure `assignSkillsByEmbedding(unit, skills, { skillVectors, chunkVectors, threshold })` + `cosineSimilarity` + `parseVector`; `surfaceMatch` exported from `assignSkillsToChunks.ts`. (PR commit `e05de70`)
- `SkillOntologyRepository.loadSkillVectors(names)` — `skill_ontology.embedding` lookup → `Map<name, number[]>`. (`032b153`)
- `reenrichSkippedChunks.ts` — `embedding::text` added to the residue SELECT; run-wide skill-vector cache; per-unit (file-path-scoped) chunk-vector back-map; `enrichUnit` uses the lane when both vector maps are non-empty, else the exact prior surface-match path. `run-ingestion` wires `skillVectorLookup` only when `canonicalVocab` is present. **Fail-open**; flag-off / per-chunk paths byte-for-byte unchanged; `ENRICH_PER_FILE` default stays OFF. (`c0ff886`)
- `run-per-file-eval.ts` + `perFileEval.ts` — report-only threshold sweep: enrich **once**, re-fan per threshold (no Nx Bedrock), log recall/precision per variant. (`04a15b8`)

Final whole-branch review (opus): **READY TO MERGE** on engineering grounds — byte-identity, per-unit keying, fail-open, report-only enrich-once all verified. Suites green (shared 34, ingestion 125). The code is correct; the **idea** is what failed.

---

## 2. Eval result — the lane does not recover recall

Sweep on `Nelson-Lamounier/ai-applications`, 200 residue chunks / 107 files, `USE_CANONICAL=true`, **actual cost $0.41** (309 Haiku calls, 454K in / 12K out tokens):

| variant | recall | precision | skill placements added vs surface-only |
|---|---|---|---|
| surface-only | 0.740 | 0.972 | — |
| embedding @0.30 | 0.742 | 0.932 | +8 |
| embedding @0.40 | 0.742 | 0.972 | 0 |
| embedding @0.50 | 0.740 | 0.972 | 0 |
| embedding @0.60 | 0.740 | 0.972 | 0 |
| embedding @0.65 | 0.740 | 0.972 | 0 |

Even at a permissive **0.30** threshold the cosine lane fires for only ~8 placements across 200 chunks and moves recall **+0.002**. Nothing nears 0.97.

---

## 3. Two honest caveats on the measurement

**(a) Confound in the harness — a real bug.** `runBaseline` in `run-per-file-eval.ts` always enriches **free-text** (`enricher.enrich`); it ignores `USE_CANONICAL`. So with `USE_CANONICAL=true` the *absolute* 0.74 compares a free-text per-chunk baseline against a canonical per-file candidate — apples-to-oranges. The production deferred per-chunk path uses **canonical** (`enrichTextCanonical`), so the valid baseline for this comparison should also be canonical-per-chunk. **The absolute 0.74 is therefore not a trustworthy per-file-vs-per-chunk number for the canonical path.**

**(b) The delta is still valid.** surface-only and every embedding variant share the *same* baseline and *same* candidate enrichment; only the threshold differs. So the conclusion **"the embedding lane adds ~0 recall"** holds regardless of the confound.

---

## 4. Why it failed — corrected diagnosis

The original hypothesis was that the loss is at **assignment** (surface-match dropping correctly-extracted skills). The data refutes this: the lane barely fires, which means the skills are missing at **extraction** — the per-file call produces fewer / different skills than per-chunk. **An assignment-level lane (surface or embedding) cannot recover skills that were never extracted for the file.** Additionally, `skill_ontology` skill-phrase vectors and `document_embeddings` code-chunk-content vectors evidently sit far apart in Titan space (cosine rarely clears even 0.30), so the cross-space signal is too weak to discriminate.

---

## 5. Decision & disposition

- **Premium stays on the working inline per-chunk path (~$7/repo).** No behaviour change to production. tucaken-app #157 (premium = `{ ENRICH_TIER1: '1' }`) is correct and stays.
- **PR #340 is held for review, not merged as a recall fix.** It is correct, tested, fail-open, and off-by-default, but it does not deliver its purpose. Options when revisited:
  - Close it; OR
  - Keep only the **eval harness** (`run-per-file-eval.ts` + `perFileEval.ts`) and `assignSkillsByEmbedding`/`loadSkillVectors` as infrastructure for future experiments, dropping the production wiring.
- **`ENRICH_PER_FILE` default remains OFF.** No default flip.

---

## 6. Recommended next steps (when cost reduction is revisited)

1. **Fix the eval confound first** — make `runBaseline` honour `USE_CANONICAL` (canonical-per-chunk baseline). Re-run once (~$0.40) to get the *clean* canonical per-file-vs-per-chunk recall. This answers the still-open question: **is per-file viable at all, even without the lane?** If clean canonical per-file recall is still well below 0.97, per-file is a dead end by construction.
2. **Option A — Bedrock Batch API** (`enrichBatch`, already implemented in `BedrockChunkEnricher`): **recall-neutral by construction** (per-chunk granularity), ~50% cheaper. Sidesteps the extraction-loss problem entirely. Cost: needs an S3 bucket + Bedrock batch IAM role provisioned, and an async submit/poll stage that fits the deferred pass (it is asynchronous, minutes-to-hours). This is the honest path to cheaper Premium without losing skills.
3. The dedup cache (shipped in #337) already makes **re-syncs of unchanged content near-free**, so the ~$7 is only the *first* enrichment of a *new* Premium repo — which lowers the urgency of any further lever.

---

## 7. Pointers

- Spec: `docs/superpowers/specs/2026-06-23-embedding-evidence-fanback-design.md`
- Plan: `docs/superpowers/plans/2026-06-23-embedding-evidence-fanback.md`
- Eval harness: `applications/ingestion/src/run-per-file-eval.ts` (report-only; `PER_FILE_EVAL_THRESHOLDS`, `USE_CANONICAL`, `PER_FILE_EVAL_LIMIT`)
- Per-file batching (parent): #337 `reenrichSkippedChunks.ts` `processResiduePerFile`
- Cost model evidence: `prompt_invocations` (agent=`chunk-enrich`, `total_cost_cents`, `invoked_at`)
