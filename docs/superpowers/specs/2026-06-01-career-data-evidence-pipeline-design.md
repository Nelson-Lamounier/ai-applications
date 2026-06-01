# Career-Data Evidence Pipeline — Design (production hardening)

> **Date:** 2026-06-01
> **Status:** Approved design (brainstorming complete). Implementation plan next.
> **Goal:** Make résumé-derived **Career Data** a first-class evidence source in the
> job-analysis → coach pipeline, and stop valid analyses from being silently dropped.
> **Repos:** `ai-applications` (analysis pipeline + resume import).
> **Origin:** Phone Screen E2E (Stripe app) returned "INFORMATION GAP" for
> `careerArcSummary`/`jdTalkingPoints` despite the user having 19 `user_career_history`
> rows, 6,482 KB chunks, and a rich Research result (12 verified matches).

## Problem (evidence, live dev RDS)

For user `1d4c645a` / Stripe app `c2156165` (analysis run `af2a3403`):

- Research succeeded: **12 verified matches, 89 KB kbContext** — but sourced **only** from
  `document_embeddings` (repo/code KB).
- **`user_career_history` = 19 rows** (résumé employment history) — **never read** by the
  analysis. `experience_embeddings = 0` (enrichment never confirmed).
- The Strategist's `analysisXml` was **replaced by the grounding verifier (block mode)**
  with the fallback *"I don't have enough grounded information to answer that confidently."*
  (68 chars).
- The **coach reads `analysis.analysisXml`** (that stub), not `research` → no evidence →
  `careerArcSummary`/`jdTalkingPoints` = "INFORMATION GAP". (`compScript` worked — it's
  ontology+input-driven.)

## Current architecture — what is intentional (keep) vs broken (fix)

**Intentional (do NOT change):**
- **Two embedding stores.** `document_embeddings` (repo/code KB; key
  `(user_id, repo_full_name, file_path, chunk_index)`) and `experience_embeddings`
  (per career entry; FK `career_entry_id → user_career_history`, `ON DELETE CASCADE`).
  Both Titan-v2 `vector(1024)` + HNSW. Deliberate domain split (portfolio vs career),
  different source/lifecycle. Keep both.
- **Two-stage résumé import with a human gate.** `run-import` extracts → `user_career_history`
  at `ready_for_review`; `run-enrichment` (Tavily + Bedrock enrichment **and** Titan
  embedding) is dispatched by admin-api **only after the user confirms** their reviewed
  history (+ free-tier cap of 5 enriched roles). Keep the consent model.

**Broken (fix):**
1. The Research agent has **no read path** to `user_career_history` or
   `experience_embeddings` — only `document_embeddings` (+ optional `resumes.content_json`
   as *formatting reference only*).
2. Career data is **invisible until confirmation** — embeddings only exist post-enrichment,
   so a freshly-imported résumé yields career-blind analyses.
3. The **grounding verifier in `block` mode** replaces a genuinely-cited analysis with a
   one-line stub (false-positive), poisoning every downstream stage.
4. The **coach reads `analysisXml`, not `research`** — even a good Research result never
   reaches the coach.

## Components (3 — recommend 3 sequenced PRs)

### Component A — Career data into the Research/analysis pipeline

**A1. Baseline-embed at extraction** — `applications/resume-import-processor/src/run-import.ts`
- After `persistCareerEntries(...)` (Step 4), write **baseline** `experience_embeddings`
  for each new `user_career_history` row, embedding a single `role_description` chunk built
  from `raw_data` (title + company + period + highlights). Key by `content_hash`.
- `run-enrichment` continues to write the **richer enriched chunks** later; it must
  **upsert by `(career_entry_id, chunk_type, content_hash)`** (replace baseline
  `role_description` when enrichment produces a better one; add the other chunk types).
- Net: career data is retrievable from the moment of import; enrichment improves quality.
- Reuse the existing Titan embedder + `embedAndPersistEntry` path where possible; factor a
  shared `embedCareerEntryBaseline()` so import and enrichment share chunk-build + upsert.

**A2. Career vector adapter** — `applications/shared/src/rds/implementations/RdsExperienceVectorStore.ts` (new)
- Implements the same query port as `RdsVectorStore` (`querySimilar` → vector + optional
  hybrid), but against `experience_embeddings` with its projection
  (`career_entry_id`, `chunk_type`, `content`, `metadata`, similarity). User-scoped by
  `user_id` (RLS-compatible). No change to `RdsVectorStore` (no table-hardcode hacks).

**A3. Hybrid evidence assembly** — `applications/job-strategist/src/agents/research-agent.ts`
- **Structured injection (always available):** load top-N `user_career_history` entries for
  the user (order by recency / `display_order`, any `enrichment_status`), format a
  **"Career History (verified from your résumé)"** section that the model **MAY cite as
  evidence** (distinct from the résumé "formatting reference only" path). Present in **both**
  PATH A and PATH B.
- **Vector query (ranked):** add a parallel retrieval over `RdsExperienceVectorStore` keyed
  on JD text; merge results into the evidence set, deduped, tagged source `career:`.
- Both feed `kbContext`/evidence so `verifiedMatches` can cite employment history, not just
  repos. Degrades gracefully: no career rows → no career section, no career query results.

### Component B — Grounding verifier hardening

`applications/job-strategist/src/run-pipeline.ts`
- Change the strategist analysis grounding from `mode: 'block'` → **`mode: 'flag'`**
  (matches `run-case-study.ts`): the verifier logs + emits `ungrounded` telemetry but the
  **real analysis is served** instead of being replaced by the fallback stub.
- Keep `block` available behind config/env (e.g. `GROUNDING_MODE`) for a future stricter
  tier; default `flag`.
- Rationale: substituting a one-line stub for a 12-citation analysis is worse for users than
  serving a flagged analysis; `job_strategist_ungrounded_paths_total` already exists to
  monitor quality. Honesty is preserved — ungrounded claims are surfaced, not hidden.

### Component C — Coach consumes research

`applications/job-strategist/src/run-coach.ts` + `applications/job-strategist/src/agents/coach-agent.ts`
- `run-coach` already loads `research` (used only for `seniority`). Pass `research` into
  `executeCoachAgent` and add a **"Verified Evidence"** block to `buildCoachMessage` built
  from `research.verifiedMatches` (+ `partialMatches`/`gaps`), `fitSummary`, and
  `experienceSignals`.
- `careerArcSummary`/`jdTalkingPoints` then ground on `research` even when `analysisXml` is
  thin. The constraint block + comp path are unchanged.

## Data flow (after)

```
résumé upload
  └─ run-import: extract → user_career_history(ready_for_review)
                         → baseline experience_embeddings        [A1]
  └─ (user confirms) run-enrichment: enrich + upsert richer experience_embeddings [A1]

job analysis (run-pipeline)
  └─ Research agent evidence =
        document_embeddings (repo KB)                            [existing]
      + experience_embeddings (RdsExperienceVectorStore, vector) [A2/A3]
      + user_career_history (structured, citeable injection)     [A3]
  └─ Strategist → analysisXml; grounding mode = flag (serve)     [B]
  └─ persist metadata.analysis + metadata.research

coach (run-coach)
  └─ buildCoachMessage = analysisXml + Verified-Evidence(research) + stage-prep block [C]
  └─ coaching_content (careerArc/jdTalkingPoints now grounded)
```

## Error handling & degradation
- No career rows / no career embeddings → career section + career query simply absent
  (analysis falls back to repo KB as today). No errors.
- `RdsExperienceVectorStore` query failure → log + continue with the other evidence sources
  (fail-open, like the existing retrieval).
- Baseline embed failure during import → log non-fatal; import still reaches
  `ready_for_review` (don't block the user on embedding).
- Grounding `flag` never blocks; on verifier error, serve the analysis.
- `research` absent in metadata (older runs) → coach omits the Verified-Evidence block.

## Testing
- **A1**: unit — baseline chunk build + content_hash; integration — after import, N career
  rows → N baseline `experience_embeddings`; after enrichment, chunks upserted (no dupes).
- **A2**: `fakePool` unit tests mirroring `RdsVectorStore` tests — query shape, user scoping,
  empty result.
- **A3**: unit — structured career section rendered when rows exist / omitted when none;
  career vector results merged + deduped; PATH A and PATH B both include career evidence.
- **B**: unit/integration — `flag` mode serves the original analysis (assert `analysisXml`
  is NOT the fallback) while still emitting the ungrounded metric.
- **C**: unit — `buildCoachMessage` includes verified-evidence text when `research` present;
  omitted when absent; coach output parses with phone-screen fields.
- **E2E** (manual, dev): re-run Stripe analysis + coach → `careerArcSummary`/`jdTalkingPoints`
  populated (no "INFORMATION GAP").

## Decomposition (implementation order)
1. **PR-A** Career data into analysis (A1+A2+A3) — the core, biggest.
2. **PR-B** Grounding `block→flag` — small, unblocks valid analyses.
3. **PR-C** Coach consumes research — small, Spec-2a follow-up.
Each is independently shippable; B and C are valuable even before A lands.

## Out of scope
- Changing the two-store split or the résumé human-in-loop consent model (both intentional).
- Reading `projects`/`project_*` into analysis (separate domain; repo KB already carries
  project evidence).
- Passing `RESUME_ID` automatically on analysis dispatch (a separate résumé-linkage concern).
- UI changes / Spec 2b (coach dispatch trigger, per-stage persistence).
- Comp benchmark vetting (tracked separately).
