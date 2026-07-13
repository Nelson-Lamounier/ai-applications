# ATS Subsystem — Refactor + Fixes — Design

**Date:** 2026-07-13
**Branch:** fresh branch off `develop` (independent of PR #477 summary work)
**Status:** Approved design — pending implementation plan

## Problem

`applications/job-strategist/src/ats/` is 26 flat files (~6,200 LOC) spanning at
least five distinct concerns with no folder structure — it is hard to know what
each system is or does. A four-agent deep review also surfaced ~20 findings,
including truthfulness-critical bugs in the fuzzy-matching primitives that sit
UNDER the anti-fabrication classification (a résumé generator's core promise).

## Goals (in scope now)

1. **Refactor** the flat `ats/` folder into named subsystems, each with a README
   stating what it is and does. Behaviour-neutral.
2. **Fix all review findings**, from the Critical matching bugs down to hygiene.

## Non-goals (deferred, documented here)

- **Phase 3 — Summary <-> ATS wiring**: wire the now-standalone summary agent to
  the ATS so the resume Summary is ATS-optimised against the JD. The USER triggers
  this after Phases 1+2 land. Out of scope here.
- **Claim-based number grounding**: the review fork chose the TARGETED number-
  provenance fix (constrain the allowed set to verbatim evidence + re-strip after
  rewrites), keeping the value-membership model. A full claim-scoped redesign is a
  later, separate effort.
- **Full free-tier/paid coverage unification**: the fork chose EXTRACT-SHARED-CORE
  (one shared matching primitive module, tier orchestration stays separate), not a
  single end-to-end engine.

## Phasing & process

The refactor moves files; the fixes change logic. Reviewing them together makes a
move indistinguishable from a behaviour change, so they are two phases, two PRs,
on one fresh branch off `develop`:

- **Phase 1 — Refactor (behaviour-neutral).** Move files into subsystem folders +
  extract the shared matching primitives into `matching/`. Zero logic change.
  Gate: full job-strategist suite green with ONLY import-path edits to tests;
  each moved file verified content-identical; `matching/` extraction pinned by the
  existing matcher tests. Own PR.
- **Phase 2 — Fixes.** Every finding fixed IN the new structure, each TDD with a
  test/eval. Own PR, stacked on Phase 1. Large files are split into smaller units
  only where a fix already opens them (not during Phase 1).

## Phase 1 — Folder taxonomy

Six named subsystems under `ats/`, each with a one-paragraph `README.md`
(what it is, inputs/outputs, where the pipeline calls it). Direct imports (no
barrels — matches the `agents/` reorg, avoids circular-dep risk). `run-pipeline.ts`
(imports ~20 ats symbols) and other consumers get rewritten import paths.

```
ats/
  matching/   SHARED matching primitives: canon/normalise, token match, alias maps,
              the tier ladder. The ONE place fuzzy matching lives.
              (extracted from keyword-match.ts + the duplicated padded()/canon copies
               in vendor-provenance, code-truth, tool-evidence-retrieval, evidence-lane)
  gate/      The ATS-check GATE: render -> parse-back -> score JD coverage -> store.
              run-ats-check, checks, parse-back, store-ats-artifacts, ats-check.schema,
              jd-keywords, grounded-coverage (free), attainable, evidence-fit (free)
  grounding/  Anti-fabrication: skill-evidence ledger + provenance + demotions.
              skill-evidence-ledger, ledger-provenance, number-provenance,
              vendor-provenance, code-truth, tool-evidence-retrieval, evidence-lane
  reconcile/  Correct matcher verdicts against hard facts.
              years-gap-reconcile, education-reconcile, migration-reframe
  context/    Grounding context fed to the matcher/writer.
              repo-profile, tech-transfer-context, retrieval-prefilter,
              canonical-jd-skills, jd-keywords-union
  length/     2-page PDF budget enforcement. length-budget
```

The `matching/` extraction is the only Phase-1 change beyond a move — same
functions, new home, no logic change, pinned by existing tests. Exact per-file
placement (e.g. which of keyword-match's functions are primitives vs coverage
orchestration) is nailed in the implementation plan; the byte-move + green-suite
gate proves losslessness.

## Phase 2 — Fix inventory

### matching/ (precision core; fixes auto-propagate to both tiers)
- **F1 [Critical]** `tokenOverlapMatch` no longer reduces a multi-word term to a
  single generic token; requires the term's discriminating token(s). Regression
  fixture: `AI Engineering` must NOT match `Data Engineering Pipelines`.
- **F4 [Important]** `matchTier1` gains a proximity/co-occurrence requirement for
  multi-word terms. Regression fixture: `project management` with "project" and
  "management" in unrelated sentences must be false.

### grounding/
- **F2 [High]** Seed the number allowed-set from VERBATIM `quantifiedEvidence`
  only; stop folding `sourceCitation` free text into it (`run-pipeline.ts:1135,1260`).
- **F3 [High]** Re-run `stripInstructionMetrics` after condense/expand and after
  surface-keywords (`length-budget.ts:210-273`, surface-keywords), not just once
  after the first writer pass.
- **[Med]** Negation/polarity guard in `ledger-provenance` before attaching a KB
  passage as supporting ("migrated away from Kubernetes" must not corroborate a
  Kubernetes claim).
- **[Low]** Short-canonical provenance: allow attachment for known short tech
  names (`SQL`,`Go`,`AWS`,`EKS`) currently filtered by the <4-char token cut.
- **[Low]** Telemetry distinguishing "guard ran, found nothing" from "guard
  disabled because ontology load failed" (vendor-provenance, code-truth).
- **[Dup]** Fully extract the local `padded()`/`canon` copies into `matching/`.

### coverage/
- **F5 [Important]** Reconcile the two disagreeing pass signals. They measure
  different things — `status` = valid ATS document + grounded coverage;
  `attainablePassed` = honest verified-only keyword coverage — so do NOT collapse
  them. Instead define ONE headline `passed = (status === 'passed') &&
  (attainablePassed !== false)`, keep both sub-fields on the result for detail,
  persist all of them together (see F6), document the precedence in `checks`, and
  emit a single reconciled Prometheus outcome instead of two that can disagree.
- **F6 [Important]** Persist the attainable fields (`attainableTotal/Covered/
  Passed`, `surfacedKeywords`) to `resumes.ats_check_json`, not only to
  `pipeline_runs.metadata` (`run-ats-check.ts:133`).
- **F8 [Important]** Recovery UPDATE gets a row-count check + logging, mirroring
  `store-ats-artifacts` (`run-ats-check.ts:130-134`).
- **[Minor]** Make `AtsCheckResultSchema` live: `safeParse` at the store boundary,
  log on drift.
- **[Minor]** Normalise whitespace before the name/email presence check
  (`checks.ts:106`).
- **[Minor]** Parallelise the embedding tier across terms (`Promise.all`).

### length/
- **F7 [Important]** Add a per-bullet word trim to `hardTrimExperience` so the
  deterministic backstop can shrink a single over-long bullet, not only bullet
  count (`length-budget.ts:144-150`).
- **[Minor]** condense/expand: Haiku -> Sonnet per CLAUDE.md §4 (deterministically
  post-trimmed; covered by existing fail-open tests).

### reconcile/
- **F9 [Important]** Tighten `education-reconcile` regexes: `DEGREE_REQ_RE` must
  not fire on "a high degree of ownership"; `TECHNICAL_FIELD_RE` must not credit
  Political Science / Mechanical Engineering for a CS requirement (2 bugs,
  `education-reconcile.ts:20,23`). + tests.
- **F10 [Important]** `migration-reframe` `proseSurfaces` scans
  `projects[].highlights`/`.description` (`migration-reframe.ts:126`).
- **F11 [Important]** Extract the peer-predecessor-still-current guard from
  `migration-reframe` into a shared helper that `code-truth` also uses, so
  `code-truth` stops false-positive-demoting current tech (`code-truth.ts:108`).

### context/
- **[Dup]** Shared `resolveCanonical(term, aliasMap)` used by both
  `retrieval-prefilter` and `tech-transfer-context` (removes the divergent
  canonicalisation that silently degrades prefilter recall).
- **F12 [Important]** Add an RLS policy for `repo_profile` (and the sibling
  provenance tables written by the same function) via a NUMBERED migration in
  `platform-rds-bootstrap` — idempotent, checksum-ledger compliant, applied to
  dev and verified (cross-user read blocked, job-strategist role grant intact).

### hygiene
- `grounded-coverage.ts` tabs -> spaces.

## Testing / eval strategy

- **Phase 1:** full suite green with only import-path edits; per-file content-
  identity check; `matching/` extraction pinned by existing matcher tests.
- **Phase 2:** each fix TDD (failing test first). The two reproduced matching
  cases become regression fixtures. Number-grounding: unit tests + a pipeline-
  level assertion that a paraphrased-citation number is stripped. RLS migration
  applied to dev and verified. No persona/prompt changes are in scope, so no live
  A/B is required (per CLAUDE.md §5); the one LLM-touching change (length-budget
  model swap) is deterministically post-trimmed and covered by existing tests.

## Consequences

- The fuzzy-matching precision fixes (F1, F4) land in one shared `matching/`
  module and therefore fix both the paid gate and the free-tier engine at once.
- `ats_check_json` becomes the single source of truth for the honest pass-mark
  (F5, F6), removing the metadata-vs-resumes divergence.
- A new DB migration ships for `repo_profile` RLS (cross-repo change).
- Establishes the subsystem structure that Phase 3 (summary <-> ATS) will wire
  into.
