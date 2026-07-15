# lib/ Domain Reorganisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise the flat 30-file `applications/job-strategist/src/lib/` into six domain folders (db/resume/grounding/coach/observability/text), each with a README and a `__tests__/` folder holding all of that domain's tests -- pure `git mv` + import repoints, zero behaviour change.

**Architecture:** Four bisectable move batches, shared primitives first (db/text/observability) so later batches repoint once; every batch gates on the full suite matching a baseline test count captured before any move. READMEs + the placement rule land last with a repo-wide stray-import sweep.

**Tech Stack:** git mv, TypeScript import paths, jest (default testMatch discovers `__tests__/**`), ROOT eslint.

## Global Constraints

- Branch `refactor/lib-domain-folders` (exists; spec commit 97d4d94d). Base = develop (post-#487).
- PURE moves: bodies byte-identical, ONLY import statements change. `git mv` for every move (diff must show renames).
- BASELINE INVARIANT: capture the pre-refactor totals ONCE in Task 1 Step 1 (`yarn workspace @bedrock/job-strategist test 2>&1 | grep -E "Tests:|Test Suites:"`) and append them to `.superpowers/sdd/progress.md`; every task's suite run must report EXACTLY those numbers.
- P4 jest lesson: after each batch run `grep -rnE "(jest\.mock|requireActual)\(" applications/job-strategist/src --include='*.ts' | grep "lib/"` and verify every path resolves post-move (mock and its requireActual must use the SAME path); tsc does not catch these.
- Consumer sweep per moved file: `grep -rn "lib/<basename-without-ext>" applications/job-strategist/src --include='*.ts'` -> repoint every hit (`lib/x.js` -> `lib/<domain>/x.js`); moved files' own intra-lib imports become cross-domain (`./rls.js` -> `../db/rls.js` etc.); moved tests gain one depth level.
- eslint: ROOT `yarn eslint <changed files>` (no workspace binary); tsc `yarn workspace @bedrock/job-strategist exec tsc --noEmit`; ASCII-only in authored lines; English (UK); no `Co-Authored-By`; NEVER `git stash` (use `git show HEAD:<path>`).
- No changes to file/symbol names, agents/, ats/ (beyond import lines), schemas/, prompts/, manifest.

---

### Task 1: baseline + db/ + text/ + observability/ (7 files)

**Files (git mv, exact):**
- `lib/pg.ts` -> `lib/db/pg.ts`; `lib/rls.ts` -> `lib/db/rls.ts`; `lib/pipeline-runs.ts` -> `lib/db/pipeline-runs.ts`
- `lib/pipeline-runs.dropInvalidProjects.test.ts` -> `lib/db/__tests__/pipeline-runs.dropInvalidProjects.test.ts`
- `lib/strip-cdata.ts` -> `lib/text/strip-cdata.ts`; `lib/strip-document-sections.ts` -> `lib/text/strip-document-sections.ts`
- `lib/strip-cdata.test.ts` -> `lib/text/__tests__/strip-cdata.test.ts`; `lib/strip-document-sections.test.ts` -> `lib/text/__tests__/strip-document-sections.test.ts`
- `lib/stage-timing.ts` -> `lib/observability/stage-timing.ts`; `lib/violation-log.ts` -> `lib/observability/violation-log.ts`
- `lib/violation-log.test.ts` -> `lib/observability/__tests__/violation-log.test.ts`; `lib/__tests__/pipeline-stage-timing...` -- NOTE: the stage-timing test lives at `src/__tests__/pipeline-stage-timing.test.ts` (outside lib) -- verify with `grep -rl "stage-timing" applications/job-strategist/src --include='*.test.ts'`; if it is outside lib/, repoint its import only (do NOT move files outside lib/).

- [ ] **Step 1:** capture the baseline totals (command in Global Constraints) and append to `.superpowers/sdd/progress.md` as `LIB-REORG BASELINE: <suites> suites / <tests> tests`.
- [ ] **Step 2:** `git mv` the batch (create `lib/db/__tests__` etc. via the mv targets).
- [ ] **Step 3:** repoint -- for each of pg, rls, pipeline-runs, strip-cdata, strip-document-sections, stage-timing, violation-log run the consumer sweep grep and update every hit; fix moved files' own imports (e.g. pipeline-runs importing pg: `./pg.js` stays sibling) and moved tests' depths.
- [ ] **Step 4:** jest-path grep (Global Constraints) -> fix any stray; full suite == baseline; tsc clean; eslint changed files.
- [ ] **Step 5: Commit** `refactor(job-strategist): lib/db + lib/text + lib/observability -- shared primitives into domain folders`

### Task 2: resume/ (9 files + their tests)

**Files (git mv):** `resume-skeleton.ts`, `resume-reconciler.ts`, `experience-roster.ts`, `preserve-resume-fields.ts`, `summary-integrity.ts`, `resume-prose.ts`, `candidate-contact.ts`, `metrics-ledger.ts`, `claim-strength.ts` -> `lib/resume/`; tests `experience-roster.test.ts`, `preserve-resume-fields.test.ts`, `summary-integrity.test.ts`, `resume-prose.test.ts`, `candidate-contact.test.ts`, `metrics-ledger.test.ts` (co-located) AND `lib/__tests__/resume-skeleton.test.ts` + `lib/__tests__/resume-reconciler.test.ts` -> `lib/resume/__tests__/`.

- [ ] **Step 1:** `git mv` the batch.
- [ ] **Step 2:** consumer sweep per basename (claim-strength has ats/ + agents/ consumers; metrics-ledger has run-pipeline; candidate-contact run-pipeline; others run-pipeline + agents). Intra-lib: any of these importing db/text files now hop `../db/...`.
- [ ] **Step 3:** jest-path grep; full suite == baseline; tsc; eslint.
- [ ] **Step 4: Commit** `refactor(job-strategist): lib/resume -- assembly + integrity domain (incl. metrics-ledger + claim-strength placements)`

### Task 3: grounding/ (7 files) + coach/ (7 files) + their tests

**Files (git mv):**
- grounding: `path-grounding.ts`, `path-grounding-loader.ts`, `gap-cause.ts`, `corrective-retrieval.ts`, `kb-stats.ts`, `dedupe-skill-gaps.ts`, `evidence-provenance.ts` + tests `path-grounding.test.ts`, `gap-cause.test.ts`, `corrective-retrieval.test.ts`, `kb-stats.test.ts`, `dedupe-skill-gaps.test.ts`, `evidence-provenance.test.ts` -> `lib/grounding/` + `lib/grounding/__tests__/`.
- coach: `bar-raiser-grounding.ts`, `coach-grounding.ts`, `coach-prose.ts`, `coaching-notes-text.ts`, `final-validation.ts`, `ground-talking-points.ts`, `leadership-principles-repository.ts` + tests `bar-raiser-grounding.test.ts`, `coach-grounding.test.ts`, `coach-prose.test.ts`, `final-validation.test.ts`, `ground-talking-points.test.ts`, `leadership-principles-repository.test.ts` -> `lib/coach/` + `lib/coach/__tests__/`.

- [ ] **Step 1:** `git mv` both batches. After this step `lib/*.ts` at the root must be EMPTY (`ls applications/job-strategist/src/lib/*.ts 2>/dev/null` -> nothing) and `lib/__tests__/` must be empty -> `rmdir` it.
- [ ] **Step 2:** consumer sweeps (grounding consumers: run-pipeline + agents; coach consumers: run-coach + agents; evidence-provenance: run-pipeline). Intra-lib hops (e.g. evidence-provenance importing rls -> `../db/rls.js`; corrective-retrieval importing anything from db/).
- [ ] **Step 3:** jest-path grep; full suite == baseline; tsc; eslint.
- [ ] **Step 4: Commit** `refactor(job-strategist): lib/grounding + lib/coach -- truth-keeping and coach-lane domains`

### Task 4: READMEs + placement rule + final sweep

**Files (create):** `lib/README.md` (the spec's placement rule VERBATIM -- copy from docs/superpowers/specs/2026-07-15-lib-domain-reorg-design.md section "The placement rule", plus the folder map); `lib/db/README.md`, `lib/resume/README.md`, `lib/grounding/README.md`, `lib/coach/README.md`, `lib/observability/README.md`, `lib/text/README.md` -- each 5-15 lines: what the domain owns (list its files with one-line purposes lifted from their doc headers), the invariant it enforces, and "adding a file here" guidance consistent with the placement rule.

- [ ] **Step 1:** write the seven READMEs (ASCII; UK English).
- [ ] **Step 2:** FINAL SWEEP -- all must be clean:
  - `grep -rnE "from '.*lib/(pg|rls|pipeline-runs|strip-cdata|strip-document-sections|stage-timing|violation-log|resume-skeleton|resume-reconciler|experience-roster|preserve-resume-fields|summary-integrity|resume-prose|candidate-contact|metrics-ledger|claim-strength|path-grounding|path-grounding-loader|gap-cause|corrective-retrieval|kb-stats|dedupe-skill-gaps|evidence-provenance|bar-raiser-grounding|coach-grounding|coach-prose|coaching-notes-text|final-validation|ground-talking-points|leadership-principles-repository)(\.js)?'" applications/job-strategist/src --include='*.ts'` -> ZERO hits (every import now carries a domain segment).
  - jest-path grep (Global Constraints) -> zero lib-flat strays.
  - full suite == baseline EXACTLY; tsc clean; ROOT eslint on the READMEs' sibling changed files (none expected) -- run it on any file touched since Task 3 anyway.
- [ ] **Step 3: Commit** `docs(job-strategist): lib domain READMEs + placement rule -- six self-describing domains`

---

## Self-Review

**Spec coverage:** folder map -> T1-T3 (all 30 files assigned across the three move batches; counts 7+9+14=30); single __tests__ convention -> every batch moves its tests, T3 removes the emptied lib/__tests__; placement rule + READMEs -> T4; pure-move constraints + baseline invariant + jest-path lesson -> Global Constraints enforced per task; one branch/PR -> constraints.

**Placeholder scan:** move tasks are contract-style (exact file lists + exact verify commands) per the proven ats/P4 reorg precedent -- no TBDs; the one uncertainty (stage-timing test location) carries its own verify-and-decide instruction inside T1.

**Type consistency:** n/a (no new symbols); path consistency checked -- every basename in T4's final-sweep regex appears in exactly one T1-T3 batch.
