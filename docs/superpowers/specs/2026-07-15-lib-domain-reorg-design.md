# job-strategist lib/ Domain Reorganisation -- Design

**Date:** 2026-07-15
**Status:** Approved design -- pending implementation plan
**Precedent:** the ats/ subsystem reorganisation (PR #478) + the per-subfolder
__tests__ convention (PR #483 reorg commit). This extends the same house style
to `applications/job-strategist/src/lib/`.

## Problem

`lib/` is a flat directory of 30 source files + tests split between TWO
conventions (co-located `*.test.ts` for the older files, `__tests__/` for the
PR-B additions). Ahead of a deeper job-strategist system-design review, the
directory needs a categorised structure and a documented placement rule so it
stays organised as files are added.

## Goals

1. Six domain subfolders, each with a README and a `__tests__/` folder holding
   ALL of that domain's tests (single convention).
2. A documented placement RULE in `lib/README.md` so future files land in the
   right place without re-litigating.
3. Pure structural refactor: `git mv` (history-preserving), byte-identical
   bodies, only import lines change. Zero behaviour change.

## Non-goals

- Renaming files or symbols; splitting/merging modules; touching code outside
  the moves' import repoints; changes to agents/, ats/, schemas/, prompts/.
- Any prompt/manifest change (none of these files are prompt content).

## The folder map (user decision)

```text
lib/
  db/             pg.ts, rls.ts, pipeline-runs.ts
  resume/         resume-skeleton.ts, resume-reconciler.ts, experience-roster.ts,
                  preserve-resume-fields.ts, summary-integrity.ts, resume-prose.ts,
                  candidate-contact.ts, metrics-ledger.ts, claim-strength.ts
  grounding/      path-grounding.ts, path-grounding-loader.ts, gap-cause.ts,
                  corrective-retrieval.ts, kb-stats.ts, dedupe-skill-gaps.ts,
                  evidence-provenance.ts
  coach/          bar-raiser-grounding.ts, coach-grounding.ts, coach-prose.ts,
                  coaching-notes-text.ts, final-validation.ts,
                  ground-talking-points.ts, leadership-principles-repository.ts
  observability/  stage-timing.ts, violation-log.ts
  text/           strip-cdata.ts, strip-document-sections.ts
```

Each folder: `README.md` (what the domain owns, extension points) +
`__tests__/` (every test for that domain's files, including the currently
co-located `*.test.ts` and the existing `lib/__tests__/` pair).

## The placement rule (goes verbatim into lib/README.md)

A `lib/` file lives in the domain whose INVARIANT it enforces, not the
entrypoint that calls it.

- `db/` -- connection/RLS/persistence primitives shared by every entrypoint.
- `resume/` -- deterministic resume assembly and integrity.
- `grounding/` -- evidence/retrieval truth-keeping.
- `coach/` -- coach-lane helpers.
- `observability/` -- timing and violation instrumentation.
- `text/` -- format-level string utilities with no domain knowledge.

New file? If it enforces a truthfulness rule -> grounding or resume; if it
touches a table -> db; if it is callable from any pipeline without domain
context -> text or observability.

## Judgement placements (locked)

- `evidence-provenance.ts` -> grounding/ (provenance truth-keeping; its DB
  writes are incidental to the invariant it exists for).
- `metrics-ledger.ts` -> resume/ (the supply side of the resume metric-honesty
  loop).
- `claim-strength.ts` -> resume/ (the shared resume-rewrite prompt rule;
  ats/agents importing it does not decide placement -- the invariant does).

## Execution constraints

- `git mv` for every move (renames in the diff, history preserved).
- Bodies byte-identical; ONLY import statements change (in the moved files,
  their tests, and the ~40 external consumers across run-pipeline.ts,
  run-coach.ts, run-case-study.ts, run-clustering.ts, agents/, ats/,
  __tests__/).
- The Phase-4 lesson applies: `jest.mock`/`jest.requireActual` string paths do
  not fail tsc -- grep them explicitly after the moves.
- Gates per commit: full job-strategist suite green, tsc clean, ROOT eslint on
  changed files, ASCII-only in authored lines (READMEs + import lines), no
  behaviour change (test counts identical before/after).
- One branch (`refactor/lib-domain-folders` off develop), one PR.

## Consequences

- lib/ becomes six self-describing domains with a stated growth rule; the
  READMEs double as the index for the upcoming system-design review.
- ~40 consumer files get one-line import updates; no runtime diff.
