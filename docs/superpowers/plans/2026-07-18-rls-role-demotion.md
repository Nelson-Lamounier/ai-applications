<!-- @format -->

# RLS Role Demotion Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RLS ritual real. Every transactional writer in ai-applications that sets `app.current_user_id` today does so on a superuser connection that bypasses RLS entirely — the `set_config` calls are inert, and job-strategist's `withUserRls` doc comment claiming enforcement is false. Fix: one shared demoting helper (`BEGIN → SET LOCAL ROLE tucaken_app → set_config → fn → COMMIT`), adopted by every ritual writer across shared, job-strategist and ingestion.

**Architecture:** A single `withUserRls(pool, userId, fn)` in `applications/shared/src/rds/` becomes the source of truth (the canonical order comes from `docs/superpowers/plans/2026-05-16-rls-secure-by-default.md:176-184`). Job-strategist's local `rls.ts` delegates to it (its false comment corrected). Ingestion's seven inline-ritual writers adopt it. Read-path `set_config` sites and documented superuser escape hatches (cost ledger, provisioning-class writes) are left as-is with an explicit comment. Live gate: a dispatched-shape unified sync in dev must complete with all per-user writes succeeding under the demoted role.

**Tech Stack:** TypeScript, pg, jest (mocked-client call-order tests).

## Global Constraints

- Canonical transaction shape (exact statement order, asserted in tests): `BEGIN` → `SET LOCAL ROLE tucaken_app` → `SELECT set_config('app.current_user_id', $1, true)` → writer statements → `COMMIT`; `ROLLBACK` on error; `client.release()` in finally. `SET LOCAL` auto-reverts at transaction end (PgBouncer-transaction-pooling safe); never use plain `SET ROLE`.
- Verified-safe adoption set ONLY (grants + policies confirmed for every table): do not demote any path not listed; every `set_config` site NOT adopted must gain a one-line comment stating why (read path, or documented superuser escape hatch per the 2026-05-16 plan D4 list).
- Zero behaviour change intended for correct data: all policies are `user_id = current_setting('app.current_user_id', true)::uuid` and every adopted writer already scopes rows to that user. A write that fails post-demotion is a genuine RLS violation surfacing — that is the point.
- The shared helper is the only implementation; job-strategist's `rls.ts` becomes a re-export/delegation (its false "connects as tucaken_app / RLS ENFORCED" comment rewritten to the truth).
- UK English; no AI trailers; ESLint clean; ESM `.js`; per-task gates `tsc -b shared ingestion job-strategist` + full jest in touched packages (4 documented pre-existing job-strategist failures only).
- Branch `fix/rls-role-demotion`, one PR.

---

### Task 1: Shared demoting helper + shared-package writer adoption

**Files:**

- Create: `applications/shared/src/rds/with-user-rls.ts` + `__tests__` (or beside per that folder's convention): `export async function withUserRls<T>(pool: Pool, userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>` implementing the canonical shape. Export via `rds/index.ts` + root barrel.
- Adopt in shared transactional ritual writers (replace their inline BEGIN/set_config blocks): `projects/system-tour/system-tour-persistence.ts` (both methods), `stage-prep/dsa-evidence.ts`, `stage-prep/ai-evidence.ts`, `stage-prep/story-mining-persistence.ts`, `rds/implementations/RdsRepoActivityStore.ts`, `TechnologyEvidenceRepository.ts`, `TechnologyParityRunRepository.ts`, `RdsUserProfileRollupRepository.ts`, `RdsRepoFileStateRepository.ts`. VERIFY each file's ritual is transactional-write before converting; any site that is read-only (`RdsDiagnosticInputsReadRepository`, `RdsCareerHistoryReadRepository`, `retrieval/implementations/PgVectorRetriever.ts`) is left unchanged with a `// read path: superuser connection; RLS enforcement not required — rows are user_id-scoped by the query itself` comment.
- Tests: helper gets the canonical order test (`calls[1] === 'SET LOCAL ROLE tucaken_app'`, per the 2026-05-16 plan pattern); each adopted writer's existing test gains/updates a SET LOCAL ROLE assertion (the shared tests are mostly order-independent `toContain` style — add the role assertion).

- [ ] TDD helper → adopt → `tsc -b` + shared jest + ingestion jest (consumers) → commit `fix(rds): withUserRls demotes to tucaken_app - shared writers enforce RLS`

---

### Task 2: Job-strategist adoption + false-comment correction

**Files:**

- Modify: `applications/job-strategist/src/lib/db/rls.ts` — delegate to the shared helper (keep the local export name so the 9 call sites are untouched); REWRITE the header comment to the truth: the pool connects as superuser via `platform-rds-credentials`; enforcement comes from the in-transaction `SET LOCAL ROLE tucaken_app` demotion this helper performs.
- Update the positional call-order tests the research identified: `lib/grounding/__tests__/evidence-provenance.test.ts` (indices shift by one), `project-evidence-block` tests, `pipeline-runs` tests, `repo-profile` tests, `store-ats-artifacts` tests, `run-ats-check` tests — each asserts the new `SET LOCAL ROLE` statement in position 1.

- [ ] Implement → `tsc -b` + job-strategist jest (4 pre-existing failures only) → commit `fix(job-strategist): withUserRls actually demotes - correct the false RLS-enforced claim`

---

### Task 3: Ingestion adoption + sweep + comment discipline

**Files:**

- Adopt the shared helper in the seven ingestion ritual writers: `persistence/RepositoryProfileRepository.ts` (3 sites), `persistence/RepoFactsRepository.ts`, `persistence/UnifiedParityRunRepository.ts`, `persistence/RdsConceptEvidenceRepository.ts`, `persistence/RepositoryProfileEmbeddingsRepository.ts`, `util/applyPostSyncProjectAction.ts`, `util/reenrichSkippedChunks.ts` (the two `chunk_enrichment_cache` transaction sites).
- Sweep: `grep -rn "set_config('app.current_user_id'" applications | grep -v dist` — every remaining hit must be inside the shared helper, a read-path comment site, or a documented superuser escape hatch; the sweep result goes in the report.
- Update the ingestion writers' call-order tests (`RepoFactsRepository.test`, `RdsConceptEvidenceRepository` tests, `doc-type-backfill` untouched — no ritual, document_embeddings superuser bulk path, add the comment there too).

- [ ] Implement → full gates all three packages → commit `fix(ingestion): persistence writers enforce RLS via withUserRls`

---

### Task 4: Ship + live gate (controller)

- [ ] Full `tsc -b` all packages; full jest x3; ESLint on branch files; PR `fix(platform)!: RLS role demotion - the set_config ritual now enforces` with the systemic framing + escape-hatch inventory; CI; merge.
- [ ] Post-merge live gate: wait for the ingestion + job-strategist images; run a dispatched-shape unified sync (hand-rolled Job, FORCE_REINDEX=true) for one repo in dev; verify: job completes, `repo_facts`/`concept_evidence`/`repository_profiles` rows updated (fresh `computed_at`/`extracted_at`), no RLS permission errors in logs. Record in ledger + update the memory note (the observation is then CLOSED).

## Self-review notes

- Scope holds to the verified-safe set from the research (grants+policies confirmed per table; no FORCE RLS anywhere; sequence grants covered by 003).
- The intentional-superuser inventory (2026-05-16 plan D4: provisioning, article writes, quota ledger, `prompt_invocations` cost writes, bulk `document_embeddings` upserts) is respected — none of those are adopted; each touched-adjacent site gets the explanatory comment instead.
- Rollback: single PR revert restores the inert-but-working state; no migration involved.
