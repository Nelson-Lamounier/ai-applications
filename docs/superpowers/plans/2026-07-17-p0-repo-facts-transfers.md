<!-- @format -->

# P0: Repo Fact Sheet + Typed Transfer Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialise a per-repo `repo_facts` answer sheet from existing evidence tables, and type the existing technology-transfer edges (`transfer_class`/`transfer_tier`/`transfer_basis`) so the JD matcher emits honest `transferable` verdicts instead of gaps — phase P0 of `docs/superpowers/specs/2026-07-17-jd-concept-ledger-design.md`.

**Architecture:** Two migrations (120 types the existing `technology_relationships` edges + adds missing families; 121 creates user-scoped `repo_facts`). The typed metadata flows through `loadTransferGroups()` (the only Pool-holding seam) into the matcher prompt and the deterministic verdict bucketing; the fact builder reuses `loadRepoRoleSignals`/`classifyComponentKind` and hooks best-effort into `run-ingestion.ts` plus a backfill runner. A deterministic gap-rate eval over the stored 67 JD extractions gates the phase — zero LLM cost.

**Tech Stack:** PostgreSQL (RLS, JSONB), TypeScript, pg, jest.

## Global Constraints

- Migrations: `TEXT + CHECK` (never `CREATE TYPE`); `IF NOT EXISTS` everywhere; seeds `ON CONFLICT DO NOTHING`; name-resolved seeds no-op when a canonical is absent; wrap DDL migrations in `BEGIN;`/`COMMIT;`.
- RLS pattern for user-scoped tables (verbatim convention): `ALTER TABLE t ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS rls_t ON t; CREATE POLICY rls_t ON t USING (user_id = current_setting('app.current_user_id', true)::uuid) WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);` plus `GRANT SELECT, INSERT, UPDATE, DELETE ON t TO tucaken_app;`.
- Every writer that INSERTs into an RLS table must set `SELECT set_config('app.current_user_id', $1, true)` inside its transaction.
- Two-tier honesty: a transfer-based match may NEVER land in `verifiedMatches`; the deterministic bucketing enforces this regardless of what the LLM emitted.
- Honest gaps stay gaps: ldap, kerberos, active directory must not become transferable in the eval.
- Zero new LLM calls anywhere in this phase.
- UK English; no AI co-author trailers; ESLint on touched files; ESM `.js` specifiers.
- Branch `feat/p0-repo-facts-transfers`; gates per task: `npx tsc -b shared ingestion job-strategist` + full jest in the touched package(s).

---

### Task 1: Migration 120 — typed transfer classes

**Files:**

- Create: `applications/platform-rds-bootstrap/migrations/120_transfer_class_metadata.sql`

**Interfaces:**

- Produces: columns `technology_relationships.transfer_class TEXT`, `.transfer_tier TEXT CHECK (transfer_tier IN ('full','partial'))`, `.transfer_basis TEXT`; typed rows for 7 transfer classes. Consumed by Task 2's loader.

- [ ] **Step 1: Write the migration**

Structure (follow `115_technology_transfer_seed.sql`'s name-resolved, absent-canonical-safe style — read it first):

```sql
-- Migration 120 - typed transfer classes on the technology graph
-- Adds transfer_class/tier/basis metadata to technology_relationships and
-- seeds the classes the JD gap corpus demands. Edges remain related_to;
-- typing is additive. Idempotent.
BEGIN;

ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_class TEXT;
ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_tier  TEXT;
ALTER TABLE technology_relationships ADD COLUMN IF NOT EXISTS transfer_basis TEXT;
ALTER TABLE technology_relationships DROP CONSTRAINT IF EXISTS technology_relationships_transfer_tier_check;
ALTER TABLE technology_relationships ADD CONSTRAINT technology_relationships_transfer_tier_check
    CHECK (transfer_tier IS NULL OR transfer_tier IN ('full','partial'));

-- 1) Ensure canonicals exist for families 115/117 do not cover
--    (category values MUST be from the 31-value CHECK universe of 034+036).
--    Use the exact canonical_name spellings already in the ontology
--    (verify with: SELECT canonical_name FROM technology_ontology WHERE canonical_name IN (...)):
--    aws, azure, gcp (cloud_compute), mongodb, dynamodb (database_nosql),
--    aws_secrets_manager, vault, azure_key_vault (cloud_security),
--    documentdb (database_nosql), bicep (iac).
INSERT INTO technology_ontology (canonical_name, category, status, source)
SELECT v.name, v.category, 'active', 'curated'
FROM (VALUES
    ('aws','cloud_compute'), ('azure','cloud_compute'), ('gcp','cloud_compute'),
    ('mongodb','database_nosql'), ('dynamodb','database_nosql'), ('documentdb','database_nosql'),
    ('aws_secrets_manager','cloud_security'), ('vault','cloud_security'), ('azure_key_vault','cloud_security'),
    ('bicep','iac')
) AS v(name, category)
WHERE NOT EXISTS (SELECT 1 FROM technology_ontology o WHERE o.canonical_name = v.name);

-- 2) Helper to upsert one typed edge pair (both directions), name-resolved.
--    Follow 115's INSERT ... SELECT ... ON CONFLICT DO NOTHING pattern, then
--    UPDATE the metadata columns for the class members (UPDATE is idempotent).
-- 3) Seed edges + typing per class table below.

COMMIT;
```

Classes to seed (edges pairwise within each family, both directions, `kind='related_to'`; then `UPDATE technology_relationships SET transfer_class=..., transfer_tier=..., transfer_basis=... WHERE (from_id, to_id) IN (family pairs)`):

| transfer_class | members (verify exact canonical_name in ontology; 115 uses `aws_cdk`, underscores) | tier | transfer_basis |
| --- | --- | --- | --- |
| `iac-declarative` | terraform, aws_cdk, cloudformation, pulumi, bicep | full | Declarative infrastructure-as-code: resource modelling, state, plan/apply discipline transfer directly |
| `ci-pipelines` | github_actions, gitlab_ci, jenkins, circleci | full | Pipeline-as-code CI: stages, triggers, secrets and artefact flows transfer directly |
| `container-orchestration` | kubernetes, docker_swarm, aws_ecs (whichever exist) | full | Container scheduling and service orchestration concepts transfer directly |
| `cloud-platform` | aws, azure, gcp | partial | Platform breadth transfers (compute, IAM, networking concepts); service-specific names do not |
| `document-store` | mongodb, documentdb, dynamodb | full | Document/key-value modelling, indexing and query patterns transfer directly |
| `secrets-managers` | aws_secrets_manager, vault, azure_key_vault | full | Secret lifecycle, rotation and injection patterns transfer directly |
| `observability-stacks` | grafana, prometheus, datadog, cloudwatch (whichever exist) | full | Metrics, dashboards and alerting concepts transfer directly |

IMPORTANT: before writing member lists, the implementer greps migrations 034/115/117 for the exact `canonical_name` spellings and only seeds edges between names that exist after step 1's inserts (the name-resolved INSERT pattern makes absent names no-ops, but the class must not silently end up with one member — add any genuinely missing member to the step-1 canonical inserts with a category from the 31-value universe).

- [ ] **Step 2: Test the migration against a scratch schema**

Write `applications/platform-rds-bootstrap/src/__tests__/migration-120.test.ts` only if the package has precedent for migration tests; otherwise verify by running the SQL twice against a local ephemeral Postgres IF one is available. If neither is possible in this environment, validate with `npx tsc` no-op + careful re-read, and state in the report that runtime validation happens at the dev bootstrap run (this is the existing convention for migrations — they are exercised by the bootstrap ledger job).

- [ ] **Step 3: Commit** — `feat(migrations): typed transfer classes on technology_relationships (120)`

---

### Task 2: Typed transfer groups from the loader

**Files:**

- Modify: `applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts` (loadTransferGroups, lines ~308-354)
- Modify: `applications/shared/src/index.ts` (export the new type)
- Test: `applications/shared/src/rds/implementations/TechnologyOntologyRepository.test.ts` (extend existing)

**Interfaces:**

- Produces: `interface TechTransferGroup { members: string[]; transferClass: string | null; transferTier: 'full' | 'partial' | null; transferBasis: string | null }` and `loadTransferGroups(): Promise<TechTransferGroup[]>` (CHANGED return type — currently `string[][]`).
- Consumers to update in THIS task (compile-driven): `run-pipeline.ts:2299-2320` (techGroups threading), `tech-transfer-context.ts`, `retrieval-prefilter.ts`, `demoteMisattributedVendors` (`run-pipeline.ts:2353`) — for the latter two, `.members` replaces the bare array; behaviour otherwise unchanged.

- [ ] **Step 1: Write failing tests** — extend the existing loadTransferGroups tests: (a) edges with typed metadata produce groups carrying `transferClass/transferTier/transferBasis` (metadata read from any edge in the component; if edges disagree, the first non-null wins and a warning is logged); (b) untyped edges produce `transferClass: null` groups (backwards compatible); (c) `loadCategoryGroups` fallback returns `transferClass: null` groups.
- [ ] **Step 2: Run tests, verify they fail** (return-shape mismatch).
- [ ] **Step 3: Implement** — extend the SQL to select the three new columns; carry metadata through the union-find/BFS; adapt the two call sites inside the repository. Update the four consumer sites to `.members`.
- [ ] **Step 4: Run shared + job-strategist suites; tsc -b clean.**
- [ ] **Step 5: Commit** — `feat(ontology): typed transfer groups (class/tier/basis) from technology_relationships`

---

### Task 3: Matcher consumption — honest transferable verdicts

**Files:**

- Modify: `applications/shared/src/strategist-types.ts` — `PartialMatch` gains optional `readonly matchBasis?: 'direct' | 'transferable'; readonly transferVia?: string; readonly transferBasis?: string;` (additive, optional — stored payloads stay valid)
- Modify: `applications/job-strategist/src/ats/context/tech-transfer-context.ts` — `formatTechTransferContext` prints tier + basis per group, e.g. `- terraform ~ aws_cdk ~ cloudformation (full transfer: Declarative infrastructure-as-code...)`, and for `partial` tier adds the sentence `Treat as PARTIAL evidence only - never claim direct experience.`
- Modify: `applications/job-strategist/src/agents/research/research-assessment.ts` — (a) `SkillAssessment` schema gains optional `transferVia: string` (the tool schema property description: "the evidenced sibling technology this verdict leans on, ONLY when the candidate's evidence is for a transferable sibling, not the skill itself"); (b) `assessmentsToMatching` gains a third parameter `transferGroups: TechTransferGroup[]` and enforces: any assessment with `transferVia` set NEVER buckets into `verifiedMatches` — verdict `verified`+`transferVia` is downgraded to a `PartialMatch` with `matchBasis: 'transferable'`, `transferVia`, and `transferBasis` looked up from the group containing both skill and sibling; assessments without `transferVia` behave exactly as today.
- Modify: `applications/job-strategist/src/agents/research/research-agent.ts:728` and the prompt block that documents the assessment tool — pass the groups through; one sentence in the system prompt: "When your evidence is for a transferable sibling (see Technology Transferability), emit verdict partial and set transferVia to the sibling."
- Tests: extend `research-assessment.test.ts` (bucketing: verified+transferVia downgrades; partial+transferVia carries basis; no-transferVia unchanged) and `tech-transfer-context.test.ts` (tier/basis rendering, partial-tier warning line).

**Interfaces:**

- Consumes: `TechTransferGroup` from Task 2.
- Produces: `PartialMatch.matchBasis/transferVia/transferBasis` — the UC3 payload; downstream (tucaken UI, ledger) treats them as optional.

- [ ] **Step 1: Failing tests first** (bucketing downgrade is the load-bearing one — write it before touching code).
- [ ] **Step 2: Implement; run job-strategist + shared suites; tsc -b.**
- [ ] **Step 3: Commit** — `feat(job-strategist): transferable match verdicts (matchBasis/via/basis) with verified-downgrade guard`

---

### Task 4: Migration 121 — `repo_facts`

**Files:**

- Create: `applications/platform-rds-bootstrap/migrations/121_repo_facts.sql`

```sql
-- Migration 121 - repo_facts: per-repo materialised fact sheet (spec P0, UC1/UC2)
BEGIN;

CREATE TABLE IF NOT EXISTS repo_facts (
    user_id        UUID NOT NULL,
    repo_full_name TEXT NOT NULL,
    github_repo_id BIGINT,
    role           TEXT NOT NULL CHECK (role IN ('frontend','backend','infra','mobile','data','ml','docs','shared')),
    classification TEXT,
    facts          JSONB NOT NULL,
    fact_version   INT  NOT NULL DEFAULT 1,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_repo_facts_role ON repo_facts (user_id, role);

ALTER TABLE repo_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_repo_facts ON repo_facts;
CREATE POLICY rls_repo_facts ON repo_facts
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_facts TO tucaken_app;

COMMIT;
```

- [ ] **Step 1: Write it exactly as above; commit** — `feat(migrations): repo_facts fact-sheet table (121)`

---

### Task 5: Fact builder + ingestion hook + backfill runner

**Files:**

- Create: `applications/ingestion/src/facts/build-repo-facts.ts` — pure assembly + orchestration:
  - `assembleRepoFacts(inputs): RepoFactsPayload` (pure): maps `technology_evidence` canonical+category rows into lanes using the 31-category universe — `languages` (category `language`, plus `primary_language`), `frameworks` (`framework_*`), `databases` (`database_*`), `infrastructure` (`iac`, `orchestration`, `container_runtime`, `cloud_*`), `tools` (`ci_cd`, `build_tool`, `testing`, `package_manager`, `developer_tool`, `api_protocol`, `auth`, `payment`, `message_broker`, `runtime`, `ai_platform` → judge: brokers/runtime/ai_platform go to `infrastructure`? NO — keep the mapping EXACTLY: `message_broker`→infrastructure, `runtime`→languages-adjacent tools, `ai_platform`→tools; document the mapping table in the module header); each entry `{ name, version: string|null, evidenceCount: number }` (version = any non-null version from the rows, first wins); `concepts` from existing signals only (signal-derived, no detectors yet): `has_ci`→`ci/cd`, `has_k8s_manifests||has_helm_chart||has_argocd_apps`→`container orchestration`, `has_iac`→`infrastructure as code`, `has_monitoring_config`→`observability`, `evidence_topology.has_migrations`→`database migrations`; each `{ name, detector: 'signal', files: 0 }`.
  - `buildRepoFacts(pool, userId, repoFullName): Promise<void>` — loads inputs (reuse `loadRepoRoleSignals` from `@bedrock/shared` for signals+role; one query for tech evidence canonicals with category/version scoped to the repo, code layers `('syft','treesitter','iac','dockerfile')`; `repository_profiles.classification/quality_score`; `repositories.github_repo_id/primary_language`), computes `role = classifyComponentKind(signals)`, assembles, upserts.
- Create: `applications/ingestion/src/persistence/RepoFactsRepository.ts` — `upsert(userId, repoFullName, row)` inside a transaction that first runs `SELECT set_config('app.current_user_id', $1, true)` (mirror `system-tour-persistence.ts`'s documented pattern); `ON CONFLICT (user_id, repo_full_name) DO UPDATE SET github_repo_id=COALESCE(EXCLUDED.github_repo_id, repo_facts.github_repo_id), role=EXCLUDED.role, classification=EXCLUDED.classification, facts=EXCLUDED.facts, fact_version=EXCLUDED.fact_version, computed_at=now()`.
- Modify: `applications/ingestion/src/run-ingestion.ts` (~line 914-925) — add best-effort call in the same try/catch idiom as `stampUserEvidenceMetadata`: `await buildRepoFacts(pgPool, env.userId, env.repoFullName);` with `log.warn` on failure, never fatal.
- Create: `applications/ingestion/src/run-build-repo-facts.ts` — backfill runner mirroring `run-rollup.ts`'s env contract (`USER_ID`, `PG_*`; loops all `repositories.full_name` for the user, or a single `REPO_FULL_NAME` when set; logs start/complete counts; `pushFinalMetrics` best-effort).
- Tests: `applications/ingestion/src/facts/build-repo-facts.test.ts` — pure `assembleRepoFacts` cases: (a) category→lane mapping (one row per lane); (b) version first-non-null-wins; (c) concepts from signals incl. none-fire case; (d) role passthrough. Repository test with mocked pool client asserting `set_config` runs before the upsert in the same transaction.

**Interfaces:**

- Consumes: `loadRepoRoleSignals`, `classifyComponentKind`, `RepoRoleSignals` from `@bedrock/shared` (verified exported); migration 121's table.
- Produces: `repo_facts` rows; `buildRepoFacts(pool, userId, repoFullName)` used by run-ingestion + the backfill runner.

- [ ] **Step 1: TDD the pure assembler** (failing tests → implement → green).
- [ ] **Step 2: Repository + hook + runner; tsc -b shared ingestion; full ingestion jest.**
- [ ] **Step 3: Commit** — `feat(ingestion): repo_facts builder - sync hook + backfill runner`

---

### Task 6: Deterministic gap-rate eval

**Files:**

- Create: `applications/job-strategist/src/evals/transfer/run-gap-rate-eval.ts` — DB-backed, deterministic, ZERO Bedrock. Env: `USER_ID`, `PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD` (mirror `run-rollup.ts` requireEnv style). Logic:
  1. Load all strategist runs: `SELECT id, metadata->'jdExtraction' AS jd, metadata->'research' AS research FROM pipeline_runs WHERE user_id=$1 AND pipeline_type='strategist' AND metadata ? 'jdExtraction' AND metadata ? 'research'`.
  2. Load the user's evidenced canonicals: `SELECT DISTINCT lower(o.canonical_name) FROM technology_evidence te JOIN technology_ontology o ON o.id=te.technology_id WHERE te.user_id=$1 AND te.source_layer = ANY('{syft,treesitter,iac,dockerfile}')`.
  3. Load typed transfer groups via `TechnologyOntologyRepository.loadTransferGroups()` + the alias map for canonicalising gap skill strings.
  4. For every stored gap verdict (`research->gaps[].skill`): canonicalise; classify as `direct-evidence` (canonical in evidenced set — a would-be false gap), `transfer-convertible` (a typed group contains it AND an evidenced sibling; record class/tier/via), or `honest-gap`.
  5. Print a per-lane table (skill, occurrences, classification, via, tier) + summary percentages; exit non-zero if ANY of `ldap`, `kerberos`, `active directory` classify as convertible, or if NONE of `terraform`, `azure`, `gcp` do (assertion of the spec's gate).
- Test: `applications/job-strategist/src/evals/transfer/gap-classify.test.ts` — extract the pure classifier `classifyGap(skill, evidenced: Set<string>, groups: TechTransferGroup[], aliasMap)` into its own function in the same file or a sibling `gap-classify.ts`, and unit-test: direct hit, convertible via sibling, honest gap, alias resolution, partial-tier carried through.

**Interfaces:**

- Consumes: Task 2's `TechTransferGroup`, `loadTransferGroups`.
- Produces: the runnable P0 gate. Runner invocation: `USER_ID=... PG_...=... npx tsx src/evals/transfer/run-gap-rate-eval.ts` from `applications/job-strategist`.

- [ ] **Step 1: TDD `classifyGap`; Step 2: runner; Step 3: tsc + jest; Step 4: Commit** — `feat(evals): deterministic transfer gap-rate eval over stored JD analyses`

---

### Task 7: Full verification + PR

- [ ] **Step 1:** From `applications/`: `pkgs=$(for d in */; do [ -f "$d/tsconfig.json" ] && echo "${d%/}"; done | grep -v '^dist$'); npx tsc -b $pkgs` clean; full jest in shared + ingestion + job-strategist; ESLint on all touched files.
- [ ] **Step 2:** Straggler check: `grep -rn "string\[\]\[\]" applications/job-strategist/src applications/shared/src/rds/implementations/TechnologyOntologyRepository.ts` — no consumer still typed to the old group shape.
- [ ] **Step 3:** Commit anything outstanding; push; PR to develop titled `feat(platform)!: repo_facts fact sheet + typed transfer classes (P0)`; body per impact-commits with the migration deploy note (bootstrap applies 120+121 via the PostSync hook; the RLS writer ships in the same merge).
- [ ] **Step 4 (controller, post-merge):** run the dev bootstrap break-glass if the image updater is still dead; run `run-build-repo-facts` backfill in-cluster; execute the gap-rate eval's queries via smoke_sql to validate the gate live (terraform/azure/gcp convertible; ldap/kerberos/AD honest); record results.

## Self-review notes

- Spec P0 coverage: repo_facts (UC1/UC2) ✅ Task 4-5; transfer classes ✅ Task 1-2; matcher consumption (UC3 payload + two-tier guard) ✅ Task 3; prefilter expansion — already exists via techGroups, now typed ✅ Task 2; gap-rate eval gate ✅ Task 6. Concepts detectors deliberately absent (P2); signal-derived concepts in the fact sheet are marked `detector: 'signal'`.
- Plan deviation from spec, deliberate: the eval is deterministic convertibility classification over stored verdicts, not a 67-run LLM re-match — same gate semantics, zero cost; noted for the PR body.
- Type consistency: `TechTransferGroup` defined once (Task 2), consumed in Tasks 3 and 6; `classifyGap` signature stated in Task 6.
