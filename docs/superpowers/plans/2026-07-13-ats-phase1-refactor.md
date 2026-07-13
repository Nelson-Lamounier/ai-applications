# ATS Phase 1 — Subsystem Refactor (behaviour-neutral) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 26 flat files in `applications/job-strategist/src/ats/` into six named subsystem folders (each with a README), rewriting imports, with ZERO behaviour change.

**Architecture:** Pure file moves + import-path rewrites. No logic edits, no file splits. `keyword-match.ts` becomes the shared `matching/` module (it is already imported by 8 modules across four subsystems). Each co-located `*.test.ts` moves with its source. The gate is: full job-strategist suite green with ONLY import-path edits, and each moved file content-identical (git rename detection).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20, ts-jest.

## Global Constraints

- Repo: `applications/job-strategist`. Fresh branch off `develop`: `refactor/ats-subsystems`.
- Behaviour-neutral: no source line changes except import specifiers. No file splits (deferred to Phase 2).
- Run ESLint on changed files; typecheck: `yarn workspace @bedrock/job-strategist exec tsc --noEmit`.
- English (UK), ASCII only, in the READMEs. No `Co-Authored-By` trailer.
- Import-rewrite rule (from the `agents/` reorg): rewrite an import ONLY when the file OR its target moved; re-relativise correctly; handle extensionless relative imports too. Since EVERY `ats/` file moves, every intra-ats and ats-external import to an ats file is rewritten.

## File → folder mapping (all 26, + each `*.test.ts` moves with its source)

```
ats/matching/    keyword-match.ts
ats/gate/    run-ats-check.ts, checks.ts, parse-back.ts, store-ats-artifacts.ts,
                 ats-check.schema.ts, jd-keywords.ts, grounded-coverage.ts,
                 attainable.ts, evidence-fit.ts
ats/grounding/   skill-evidence-ledger.ts, ledger-provenance.ts, number-provenance.ts,
                 vendor-provenance.ts, code-truth.ts, tool-evidence-retrieval.ts,
                 evidence-lane.ts
ats/reconcile/   years-gap-reconcile.ts, education-reconcile.ts, migration-reframe.ts
ats/context/     repo-profile.ts, tech-transfer-context.ts, retrieval-prefilter.ts,
                 canonical-jd-skills.ts, jd-keywords-union.ts
ats/length/      length-budget.ts
```

---

### Task 1: Create the six folders + READMEs

**Files:**
- Create: `ats/matching/README.md`, `ats/gate/README.md`, `ats/grounding/README.md`, `ats/reconcile/README.md`, `ats/context/README.md`, `ats/length/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write each README** (one paragraph: what it is, in/out, where the pipeline calls it). Exact content:

`ats/matching/README.md`:
```markdown
# matching/

Shared matching primitives — the ONE place fuzzy matching lives. Normalise/canon,
token match, alias maps, and the tier ladder (`matchTerm`). Consumed by `gate/`
(the ATS gate), `grounding/` (ledger + demotions), `reconcile/`, and `context/`.
Pure functions; no I/O.
```

`ats/gate/README.md`:
```markdown
# coverage/

The ATS-check GATE. Renders the finished resume to PDF, parses it back, scores JD
keyword coverage against the parsed text, and stores the result. In: `finalResume`
(StructuredResumeData) + research verdicts. Out: `AtsCheckResult` persisted to
`resumes.ats_check_json` + PDF to S3. Entry point: `renderCheckAndStoreAts`
(`run-ats-check.ts`), called from `run-pipeline.ts`. Also holds the free-tier
coverage/fit functions (`grounded-coverage.ts`, `evidence-fit.ts`) and the
attainable-keyword split (`attainable.ts`).
```

`ats/grounding/README.md`:
```markdown
# grounding/

Anti-fabrication layer. Deterministic passes wrapped around the matcher's LLM
verdicts. Builds the skill-evidence ledger, attaches provenance (source path, lane,
KB passage), demotes claims contradicted by the actual code (`code-truth`,
`vendor-provenance`), strips ungrounded numbers (`number-provenance`). In: matcher
`verifiedMatches`/`partialMatches`/`gaps` + KB passages + code-tech maps. Out:
demoted/annotated matches fed to the writer. Called from `run-pipeline.ts` ~L875-960.
```

`ats/reconcile/README.md`:
```markdown
# reconcile/

Corrects matcher verdicts against hard facts. `years-gap-reconcile` caps the fit
rating to the true years gap; `education-reconcile` reconciles degree requirements;
`migration-reframe` rewrites stale doc-vs-code tech in resume prose to past tense.
In: matcher verdicts / rendered resume. Out: corrected verdicts / reframed prose.
```

`ats/context/README.md`:
```markdown
# context/

Grounding context fed to the matcher/writer BEFORE and around the LLM calls.
`repo-profile` builds per-repo identity; `tech-transfer-context` lists JD-relevant
transfer groups; `retrieval-prefilter` shapes KB retrieval; `canonical-jd-skills`
and `jd-keywords-union` derive the JD skill/keyword universes.
```

`ats/length/README.md`:
```markdown
# length/

2-page PDF budget enforcement. `applyLengthBudget` measures the resume and, if over,
runs a bounded LLM condense (or expand if under-full) with a deterministic hard-trim
backstop. Runs pre-render in `run-pipeline.ts`.
```

- [ ] **Step 2: Commit**
```bash
git add applications/job-strategist/src/ats/*/README.md
git commit -m "docs(ats): add per-subsystem READMEs ahead of the file move"
```

### Task 2: Move files with `git mv` (preserves history + rename detection)

**Files:** all 26 sources + their `*.test.ts`, per the mapping above.

**Interfaces:** none change yet (imports fixed in Task 3 — the tree will not compile between Task 2 and Task 3; that is expected and they are one logical unit, commit together at Task 3).

- [ ] **Step 1: `git mv` each source and its test into its folder.** Run from `applications/job-strategist/src/ats/`:
```bash
# matching
git mv keyword-match.ts keyword-match.test.ts matching/
# coverage
git mv run-ats-check.ts run-ats-check.test.ts checks.ts checks.test.ts parse-back.ts parse-back.test.ts \
       store-ats-artifacts.ts store-ats-artifacts.test.ts ats-check.schema.ts ats-check.schema.test.ts \
       jd-keywords.ts jd-keywords.test.ts grounded-coverage.ts grounded-coverage.test.ts \
       attainable.ts attainable.test.ts evidence-fit.ts evidence-fit.test.ts coverage/
# grounding
git mv skill-evidence-ledger.ts skill-evidence-ledger.test.ts ledger-provenance.ts ledger-provenance.test.ts \
       number-provenance.ts number-provenance.test.ts vendor-provenance.ts vendor-provenance.test.ts \
       code-truth.ts code-truth.test.ts tool-evidence-retrieval.ts tool-evidence-retrieval.test.ts \
       evidence-lane.ts evidence-lane.test.ts grounding/
# reconcile
git mv years-gap-reconcile.ts years-gap-reconcile.test.ts education-reconcile.ts education-reconcile.test.ts \
       migration-reframe.ts migration-reframe.test.ts reconcile/
# context
git mv repo-profile.ts repo-profile.test.ts tech-transfer-context.ts tech-transfer-context.test.ts \
       retrieval-prefilter.ts retrieval-prefilter.test.ts canonical-jd-skills.ts canonical-jd-skills.test.ts \
       jd-keywords-union.ts jd-keywords-union.test.ts context/
# length
git mv length-budget.ts length-budget.test.ts length/
```
- [ ] **Step 2: Verify no stray files remain at `ats/` root** (only the 6 folders):
```bash
ls applications/job-strategist/src/ats/    # expect: matching coverage grounding reconcile context length
```
(Do NOT commit yet — the tree does not compile until Task 3.)

### Task 3: Rewrite all imports (intra-ats + external consumers)

**Files:**
- Modify: every moved `ats/**/*.ts` that imports another (moved) ats file, and every consumer OUTSIDE ats/ that imports an ats file (`run-pipeline.ts`, `run-free.ts`, `agents/research/research-agent.ts`, `agents/writer/free-resume-writer.ts`, and any others found by grep).

**Interfaces:** all public symbols unchanged; only import specifiers change.

- [ ] **Step 1: Find every consumer of an ats path** (source of truth for the rewrite):
```bash
cd applications/job-strategist/src
grep -rn "from '.*ats/[a-z-]*\.js'" . --include='*.ts' | grep -v node_modules
```
- [ ] **Step 2: Rewrite intra-ats imports.** Inside `ats/<folder>/<file>.ts`, an import of another ats module now needs the sibling-or-cousin path. The only intra-ats imports (from the graph) are to `keyword-match`, `parse-back`, `checks`, `jd-keywords`, `store-ats-artifacts`:
  - `matching/keyword-match.js` is imported by `coverage/attainable.ts`, `coverage/run-ats-check.ts`, `grounding/{skill-evidence-ledger,vendor-provenance,code-truth,tool-evidence-retrieval}.ts`, `reconcile/migration-reframe.ts`, `context/tech-transfer-context.ts` → rewrite `from './keyword-match.js'` to `from '../matching/keyword-match.js'`.
  - Within `gate/`: `run-ats-check.ts` imports `./checks.js`, `./jd-keywords.js`, `./parse-back.js`, `./store-ats-artifacts.js` (all now siblings in `gate/`) → these stay `./…`. `checks.ts` imports `./parse-back.js` → stays `./…`.
- [ ] **Step 3: Rewrite external consumer imports.** For each hit from Step 1 outside `ats/`, change `./ats/<file>.js` → `./ats/<folder>/<file>.js` using the mapping table. Example in `run-pipeline.ts`:
```
./ats/length-budget.js            -> ./ats/length/length-budget.js
./ats/ledger-provenance.js        -> ./ats/grounding/ledger-provenance.js
./ats/run-ats-check.js            -> ./ats/gate/run-ats-check.js
./ats/ats-check.schema.js         -> ./ats/gate/ats-check.schema.js
./ats/skill-evidence-ledger.js    -> ./ats/grounding/skill-evidence-ledger.js
./ats/canonical-jd-skills.js      -> ./ats/context/canonical-jd-skills.js
./ats/attainable.js               -> ./ats/gate/attainable.js
./ats/vendor-provenance.js        -> ./ats/grounding/vendor-provenance.js
./ats/code-truth.js               -> ./ats/grounding/code-truth.js
./ats/repo-profile.js             -> ./ats/context/repo-profile.js
./ats/migration-reframe.js        -> ./ats/reconcile/migration-reframe.js
./ats/retrieval-prefilter.js      -> ./ats/context/retrieval-prefilter.js
./ats/number-provenance.js        -> ./ats/grounding/number-provenance.js
./ats/tech-transfer-context.js    -> ./ats/context/tech-transfer-context.js
./ats/tool-evidence-retrieval.js  -> ./ats/grounding/tool-evidence-retrieval.js
./ats/evidence-lane.js            -> ./ats/grounding/evidence-lane.js
./ats/education-reconcile.js      -> ./ats/reconcile/education-reconcile.js
./ats/years-gap-reconcile.js      -> ./ats/reconcile/years-gap-reconcile.js
```
Apply the SAME mapping to `run-free.ts`, `research-agent.ts`, `free-resume-writer.ts`, and any other file the Step-1 grep surfaced (e.g. `jd-keywords-union.js` → `context/`, `grounded-coverage.js` → `gate/`, `evidence-fit.js` → `gate/`).
- [ ] **Step 4: Typecheck — this is the completeness check for the rewrite:**
```bash
yarn workspace @bedrock/job-strategist exec tsc --noEmit
```
Expected: clean. Any `TS2307 Cannot find module './ats/…'` is a missed rewrite — fix it.
- [ ] **Step 5: Full suite (only import paths changed, so it must stay green):**
```bash
yarn workspace @bedrock/job-strategist test
```
Expected: same pass count as before the move (baseline: 922).
- [ ] **Step 6: Prove behaviour-neutrality — each moved source is content-identical bar imports.** For a spot sample and any file whose diff looks large:
```bash
# git should report renames (R) not delete+add; content diff should be import lines only
git diff --stat -M HEAD
git diff -M HEAD -- applications/job-strategist/src/ats/grounding/number-provenance.ts   # expect: 0 or only import lines
```
- [ ] **Step 7: ESLint changed files, then commit the move + rewrites together:**
```bash
npx eslint applications/job-strategist/src/ats applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/run-free.ts
git add -A applications/job-strategist/src
git commit -m "refactor(ats): move 26 flat files into six subsystem folders (behaviour-neutral)"
```

## Self-Review

**Spec coverage:** taxonomy (6 folders + READMEs) → Tasks 1-2; `matching/` = keyword-match move → Task 2; import rewrites → Task 3; green-suite + content-identity gate → Task 3 Steps 4-6. The `padded()/canon` dedup and any file splits are explicitly Phase 2 (not here). ✓

**Placeholder scan:** import mapping table is exact; README content is literal; commands are runnable. No TBDs.

**Type consistency:** no signatures change — Phase 1 touches only import specifiers and adds READMEs.

## Execution Handoff
Two-phase effort; this is Phase 1. Phase 2 (fixes) is a separate plan + PR stacked on this one.
