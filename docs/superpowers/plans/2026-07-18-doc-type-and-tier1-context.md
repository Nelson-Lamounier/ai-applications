<!-- @format -->

# Doc-Type Taxonomy + Strategist Tier-1 Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the doc-type gap (semantic `metadata.docType` on docs-lane chunks, queryable at retrieval — "find the ADRs" becomes categorical) and give the job-strategist its tier-1 categorical read (`repo_facts` fact sheets threaded into JD research and, through it, resume generation).

**Architecture:** PR 1 (Tasks 1-4): a pure, path-first + FP-guarded content-sniff `classifyDocType`, stamped at the ChunkerRegistry choke point for `docs`-lane files, exposed as NULL-fail-open filters in both retrievers, plus a per-file backfill runner for the existing corpus. PR 2 (Tasks 5-6): a shared `repo_facts` reader + a JD-intersected `## Repo Fact Sheets` prompt block threaded into the research agent exactly like the concept-evidence context (single insertion point; propagates to all section agents via `researchData`).

**Tech Stack:** TypeScript, pg (JSONB metadata), jest.

## Global Constraints

- `classifyDocType` is deterministic, pure, path-rules-first, content sniff ONLY when the path is inconclusive; every content sniff has a near-miss test (FP discipline).
- Taxonomy (closed set, 10 values): `readme`, `adr`, `runbook`, `troubleshooting`, `concept`, `guide`, `spec`, `changelog`, `contributing`, `doc` (fallback). `patterns/` maps to `concept`; `plans/` and `specs/` map to `spec`.
- `docType` is stamped ONLY on `fileClass === 'docs'` chunks; per-file uniform (stamped at the registry, not inside chunkers).
- Retrieval filters are pure-additive and NULL-fail-open (absent option = today's behaviour, byte-identical SQL binds otherwise).
- The strategist context block is JD-agnostic-safe: small (cap 6 items per lane), rendered from `repo_facts` rows only, empty string when no rows; threading mirrors `conceptEvidenceContext` (no persona/prompt-manifest change).
- Zero LLM calls added. UK English; no AI trailers; ESLint clean on touched files; ESM `.js` specifiers; per-task gates `tsc -b shared ingestion job-strategist` + full jest in touched packages (4 documented pre-existing job-strategist failures only).
- PR 1 on branch `feat/doc-type-taxonomy`; PR 2 on `feat/strategist-repo-facts-context` (created off develop after PR 1 merges).

---

### Task 1: `classifyDocType` (pure) + registry stamp

**Files:**

- Create: `applications/ingestion/src/knowledge/doc-type-classifier.ts` + `__tests__/doc-type-classifier.test.ts`
- Modify: `applications/ingestion/src/knowledge/ChunkerRegistry.ts` (choke point, lines ~44-51) + its test

**Classifier rules (first match wins):**

1. Filename (basename, case-insensitive): `README*` → `readme`; `CHANGELOG*` → `changelog`; `CONTRIBUTING*` → `contributing`.
2. Path segment (any position): `/decisions/` or `/adr/` or `/adrs/` → `adr`; `/runbooks/` → `runbook`; `/troubleshooting/` → `troubleshooting`; `/concepts/` or `/patterns/` → `concept`; `/guides/` or `/tutorials/` → `guide`; `/specs/` or `/plans/` or `/rfcs/` → `spec`.
3. Content sniff (ONLY when 1-2 miss; first 2,000 chars): MADR/ADR shape — a `NNNN-` numeric filename prefix AND (`## Status` or `## Decision` or a `Status:` line) → `adr`; runbook shape — (`## Symptom` or `## Diagnose`) AND (`## Fix` or `## Verify`) → `runbook`. Nothing else content-sniffs.
4. Fallback → `doc`.

Export `DOC_TYPES` (the closed 10-value list) and `classifyDocType(filePath: string, headContent: string): DocType`.

**Registry stamp** (`ChunkerRegistry.chunk`, beside `classifyFile`): when `fileClass === 'docs'`, compute `docType = classifyDocType(filePath, content.slice(0, 2000))` once per file and fold into the same `.map()`: `metadata: { ...c.metadata, fileClass, ...(fileClass === 'docs' ? { docType } : {}) }`.

**TDD:** per rule a firing case + a near-miss (e.g. a numbered SQL-ish `0001-*.md` WITHOUT status/decision headings stays `doc`; a doc mentioning "runbook" in prose without the heading pair stays `doc`; `docs/decisions/0001-x.md` → `adr` by path without content). Registry test: docs file gets `docType` on every chunk; a `source` file gets none.

- [ ] TDD → implement → `tsc -b` + ingestion jest → commit `feat(ingestion): deterministic docType taxonomy stamped on docs-lane chunks`

---

### Task 2: Retrieval filters (both readers)

**Files:**

- Modify: `applications/shared/src/retrieval/implementations/PgVectorRetriever.ts` (+ its test)
- Modify: `applications/shared/src/rds/types.ts` (`RetrievalPrefilter`) + `applications/shared/src/rds/implementations/RdsVectorStore.ts` (+ rds tests where the prefilter is covered)

**PgVectorRetriever:** add `filterByDocType?: string[]` to `RetrieveOptions` (beside `filterByFileClass`, ~line 45); thread through `queryChunkLayer`; new `$N::text[]` bind with `AND ($N::text[] IS NULL OR d.metadata->>'docType' = ANY($N))` in BOTH the `vector_ranked` and `text_ranked` CTEs (~lines 247/258). Test: option absent → SQL binds unchanged shape (null bind); option set → clause filters.

**RdsVectorStore:** add `readonly docTypes?: readonly string[]` to `RetrievalPrefilter` (types.ts:158-176, doc comment: hard include-filter for docs-lane doc types; absent = no constraint); in `runFilteredVector` destructure and add the NULL-fail-open clause alongside the hard gates (~:516-518). Test mirrors the existing prefilter tests.

- [ ] TDD both → `tsc -b shared ingestion job-strategist` + shared jest + job-strategist jest (prefilter consumers compile) → commit `feat(retrieval): docType filters in PgVectorRetriever + RetrievalPrefilter`

---

### Task 3: Backfill runner for the existing corpus

**Files:**

- Create: `applications/ingestion/src/run-stamp-doc-types.ts` + a pure helper `applications/ingestion/src/knowledge/doc-type-backfill.ts` (+ test)

**Shape** (mirror `run-rollup.ts` env contract: `USER_ID`, optional `REPO_FULL_NAME`, `PG_*`):

1. `SELECT DISTINCT repo_full_name FROM document_embeddings WHERE user_id=$1 AND metadata->>'fileClass'='docs'` (or the single repo).
2. Per repo: `SELECT file_path, content FROM document_embeddings WHERE user_id=$1 AND repo_full_name=$2 AND metadata->>'fileClass'='docs' AND chunk_index=0` → classify per file via `classifyDocType(file_path, content.slice(0,2000))`.
3. Per file (all its chunks): `UPDATE document_embeddings SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{docType}', to_jsonb($3::text)) WHERE user_id=$1 AND repo_full_name=$2 AND file_path=$4 AND metadata->>'fileClass'='docs'` (the `reenrichSkippedChunks.writeSkills` jsonb_set precedent). Batch per repo inside one transaction; log per-repo counts by docType; `pushFinalMetrics` best-effort.
4. Idempotent (re-running re-stamps the same values).

Pure helper unit-tested (grouping + classification plumbing with a mocked pool per `RepoFactsRepository.test` style).

- [ ] TDD helper → runner → gates → commit `feat(ingestion): docType backfill runner for existing docs chunks`

---

### Task 4: PR 1 verification + ship + live backfill (controller)

- [ ] Full `tsc -b` all packages; full jest shared + ingestion + job-strategist; ESLint on branch files. PR `feat(ingestion)!: semantic docType taxonomy for docs chunks + retrieval filters`; CI; merge.
- [ ] Controller, post-merge: wait for the ingestion image; run `run-stamp-doc-types` in-cluster for the pilot user; verify via SQL: docType distribution per repo (expect `adr` rows from `docs/decisions/`, `runbook` from `docs/runbooks/`, `readme` for README chunks); spot-check "find the ADRs" as a categorical SQL + a `filterByDocType: ['adr']` retriever smoke if cheap.

---

### Task 5: Shared `repo_facts` reader + strategist fact-sheet context (PR 2)

**Files:**

- Create: `applications/shared/src/rds/implementations/RepoFactsReadRepository.ts` + test; export via `rds/index.ts` + root barrel. Method: `loadForUser(userId: string): Promise<RepoFactRow[]>` where `RepoFactRow = { repoFullName: string; role: string; classification: string | null; facts: RepoFactsPayloadShape }` — `SELECT repo_full_name, role, classification, facts FROM repo_facts WHERE user_id = $1` (RLS-safe read: same-pool convention as `loadRepoConcepts`; read-only, no set_config needed if the pool role bypasses RLS the way sibling readers do — MIRROR `SkillOntologyRepository.loadRepoConcepts`'s exact connection pattern).
- Create: `applications/job-strategist/src/ats/context/repo-facts-context.ts` + test: pure `formatRepoFactsContext(rows: RepoFactRow[]): string` → `## Repo Fact Sheets` with one compact block per non-`fork`/`noise` repo: `- <repo> (<role>): languages: a, b; frameworks: ...; databases: ...; infrastructure: ...; concepts: x (11 files), y` — each lane capped at 6 entries, lanes omitted when empty, `''` when no rows. Counts come from the stored `facts` JSONB entries (`evidenceCount`/`files`); names only, no file paths (prompt-injection surface stays names+counts, like the concept block).
- Modify: `applications/job-strategist/src/run-pipeline.ts` — 13th member in the per-user `Promise.all` (~:2302-2315, `.catch(() => [])`); build the block beside `conceptEvidenceContext` (~:2335); pass as a new trailing positional arg to `executeResearchAgent` (~:2350).
- Modify: `applications/job-strategist/src/agents/research/research-agent.ts` — `repoFactsContext = ''` param, forwarded to `buildResearchMessage` opts, `sections.push` immediately after the `conceptEvidenceContext` section (~:513-515). NO persona edit (the block is self-describing) — prompt-manifest untouched.

**TDD:** formatter (caps, lane omission, fork/noise exclusion, empty), reader (SQL + row mapping), threading (the buildResearchMessage section-order test style used for conceptEvidenceContext).

- [ ] Branch `feat/strategist-repo-facts-context` off develop (after PR 1 merges) → TDD → gates (`tsc -b`, shared + job-strategist jest) → commit `feat(job-strategist): tier-1 repo fact-sheet context for JD research and resume generation`

---

### Task 6: PR 2 verification + ship (controller)

- [ ] Full gates; PR `feat(job-strategist): tier-1 categorical read - repo fact sheets in the research context`; CI; merge. Body notes the three-tier read model now explicit: tier 1 = repo_facts/concept_evidence (this PR + P0/P2), tier 2 = filter-then-rank document_embeddings (+ new docType filters), tier 3 = structured rows.
- [ ] Post-merge: no live gate required (prompt-additive, fail-open); note that the next real JD run through the UI exercises it and the analysis metadata will show the block in the research prompt context.

## Self-review notes

- Gap closure: docType stamped at the single choke point (per-file uniform), filterable in both readers, backfilled for the existing corpus — "find the ADRs" becomes `metadata->>'docType' = 'adr'`.
- Tier-1: reader + formatter + single-insertion threading gives JD research categorical facts with zero retrieval/LLM cost, propagating to resume section agents via `researchData` (the `codeStackContext` precedent).
- Type consistency: `DocType`/`DOC_TYPES` defined once (Task 1), consumed by Tasks 2-3; `RepoFactRow` defined in the shared reader (Task 5), consumed by the formatter.
