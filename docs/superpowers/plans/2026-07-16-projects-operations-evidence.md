# Projects Operations-Angle Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the projects agent JD-themed, component-kind-scoped operations evidence (retrieval-only, no new LLM) so composed bullets can describe how the systems are operated, not just what was built.

**Architecture:** Spec docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md. Three tasks: T1 theme ontology + activation; T2 kind threading + evidence gathering + pool wiring + message/persona; T3 evals + observability polish + runbook + sweep.

**Tech Stack:** TypeScript, jest, existing pgvector retrieval (`querySingleRds` injection pattern from the corrective stage at run-pipeline.ts:781), existing pool builder (`buildProjectPool` -- UNTOUCHED).

## Global Constraints

- Branch `feat/projects-operations-evidence` (exists). ONE commit per task, impact-bullet body, no Co-Authored-By.
- Gates per task: full `yarn workspace @bedrock/job-strategist test` green (growth only from the current develop baseline -- capture exact counts in T1 Step 1 and ledger them), `tsc --noEmit`, ROOT `yarn eslint <changed files>` (NEW functions complexity <= 10), ASCII-only added lines, UK English.
- NEVER `git stash`. Fail-open everywhere (no activated themes / retrieval failure / no kind-matching repos => pool byte-identical to today). NO new LLM calls. `buildProjectPool`, provenance validation, `keyword-match.ts`, `summary-coverage.ts` UNTOUCHED.
- Persona changes: front-matter version bump + manifest sha regeneration via the prompt-content-integrity suite.

---

### Task 1: theme ontology + activation

**Files:**
- Create: `applications/job-strategist/src/agents/evidence/operations-themes.ts` (+ `__tests__/operations-themes.test.ts`)

**Interfaces (Produces):**
```ts
export interface OperationsTheme { readonly key: string; readonly label: string; readonly queryTerms: string; readonly matchTerms: readonly string[]; readonly kinds: readonly string[]; }
export const OPERATIONS_THEMES: readonly OperationsTheme[]; // the seven spec entries VERBATIM
export function activateThemes(jdStrings: readonly string[]): OperationsTheme[];
// jdStrings = flattened hardRequirements skills + preferred + concepts from JdSignal (caller flattens);
// a theme activates when ANY matchTerm experienceTermMatch-es ANY jd string (import the shared predicate);
// sort by distinct jd strings hit DESC (ties: ontology order), cap 3.
```

- [ ] **Step 1:** capture the develop suite baseline (`yarn workspace @bedrock/job-strategist test` counts) into `.superpowers/sdd/progress.md`, then failing tests: MongoDB-TSE-shaped jd strings (use the extraction list from the spec driver: "production database systems", "backup and recovery", "performance tuning", "Kubernetes", "networking (DNS, TCP/IP, SSL/TLS)"...) activate database-operations + backup-recovery + one of performance-tuning/networking/cluster (assert top-3 cap + ordering by hit count); a frontend-only jd (react, css, web vitals) activates ZERO; matchTerm matching goes through experienceTermMatch (e.g. "PostgreSQL" jd string activates database-operations via the mongodb/postgresql matchTerms).
- [ ] **Step 2:** implement; gates; commit `feat(job-strategist): operations theme ontology + deterministic JD activation`

### Task 2: kind threading + evidence gathering + wiring

**Files:**
- Create: `applications/job-strategist/src/agents/evidence/operations-evidence.ts` (+ test)
- Modify: `applications/job-strategist/src/agents/evidence/project-agent-inputs.ts` (SELECT joins project_components.kind per repo -- schema verified live: project_repositories.project_component_id -> project_components.kind in {backend, ml, infra}; thread per-repo kind into ProjectAgentMeta), `applications/job-strategist/src/run-pipeline.ts` (gather after research + targets, append to verifiedMatches BEFORE buildProjectPool; reuse the corrective stage's retrieval construction pattern: RdsVectorStore.fromEnvironment() + querySingleRds(q, userId, store, k, retrievalPrefilter) -- run-pipeline.ts:777-782 is the template; wrap the whole gather in try/catch fail-open), `projects-message.ts` (operations-evidence grouping for facts whose skill matches a theme label), `prompts/content/strategist/projects-agent.md` (one composing-preference rule; version bump + manifest)
- Test: operations-evidence unit tests (kind filter, docs-path preference, caps 2/theme + 6/project, snippet cleaning <= 200 chars markdown-stripped, error fail-open), message grouping test

**Interfaces:**
```ts
// operations-evidence.ts
export interface OperationsEvidenceArgs {
  readonly themes: readonly OperationsTheme[];
  readonly projects: readonly ProjectAgentMeta[]; // with per-repo kinds
  readonly retrieve: (query: string, k: number) => Promise<ReadonlyArray<{ file: string; text: string }>>;
}
export interface OperationsEvidenceResult { readonly matches: VerifiedMatch[]; readonly factCounts: Record<string, number>; readonly byRepo: Record<string, number>; }
export async function gatherOperationsEvidence(args: OperationsEvidenceArgs): Promise<OperationsEvidenceResult>;
// one retrieve() per (project, theme) where the project has >= 1 repo of a theme kind; k = 8;
// post-filter: repoOfFile(file) in project's member repos AND that repo's kind in theme.kinds;
// docs-first ordering (.md/.mdx or /docs/ path segments), cap 2/(project,theme) and 6/project;
// VerifiedMatch = { skill: theme.label, sourceCitation: cleanSnippet(text), evidenceFiles: [file] }.
```
- Diag: `projectsAgent` metadata gains `themes: { activated, factCounts }`; Loki `projects_theme_evidence` emitted when matches.length > 0 (theme/repo/counts only -- bounded).

- [ ] **Step 1:** failing tests per the semantics above (fixtures with mixed-kind repos; an ml-only chunk rejected for a [backend, infra] theme; cross-project file attributes nowhere -- reuse of buildProjectPool proven by an integration-shaped test through the real builder).
- [ ] **Step 2:** implement + wire; gates; commit `feat(job-strategist): kind-scoped operations evidence feeds the projects pool (retrieval-only)`

### Task 3: evals + runbook + sweep

**Files:**
- Modify: `evals/projects/fixtures.ts` + graders/tests -- spec eval cases (a)-(e); `docs/runbooks/projects-agent-observability.md` -- themes surface (activation, factCounts, the projects_theme_evidence event, "which repo grounded which theme" query) + the load-bearing note on project_components.kind.
- Sweep: `git diff develop -- .../keyword-match.ts .../summary-coverage.ts .../projects-provenance.ts` shows provenance UNTOUCHED except none; buildProjectPool byte-identical (git diff on project-agent-inputs.ts limited to the SELECT/threading hunks -- verify no pool-builder hunks); suite growth only; no new Prometheus label keys.

- [ ] **Step 1:** eval fixtures + graders (reuse runtime primitives: activateThemes, gatherOperationsEvidence with a fake retrieve, buildProjectPool, provenance validator).
- [ ] **Step 2:** runbook; sweep; gates; commit `test(job-strategist): operations-evidence evals + observability runbook`

---

## Self-Review

**Spec coverage:** C1 -> T1; C1.5 + C2 -> T2 (kind threading + scoping + gather + append-before-pool); C3 -> T2 (message/persona); C4 -> T2 diag/Loki + T3 evals/runbook. Error handling restated in Global Constraints. **Placeholder scan:** clean (ontology verbatim in spec; signatures, caps, k, snippet cap concrete). **Type consistency:** OperationsTheme/gatherOperationsEvidence/VerifiedMatch names consistent across tasks; ProjectAgentMeta kind threading named in T2 and consumed nowhere else.
