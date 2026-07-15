# job-strategist lib/

Shared, non-agent, non-prompt helpers for the job-strategist pipeline: DB
primitives, deterministic resume assembly, grounding/truth-keeping, coach-lane
helpers, observability, and format-level text utilities.

## The placement rule

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

## The folder map

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

Each folder carries its own `README.md` (what the domain owns, its invariant,
extension points) and a `__tests__/` folder holding that domain's tests.

## Judgement placements (locked)

- `evidence-provenance.ts` -> grounding/ (provenance truth-keeping; its DB
  writes are incidental to the invariant it exists for).
- `metrics-ledger.ts` -> resume/ (the supply side of the resume metric-honesty
  loop).
- `claim-strength.ts` -> resume/ (the shared resume-rewrite prompt rule;
  ats/agents importing it does not decide placement -- the invariant does).
