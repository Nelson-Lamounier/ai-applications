# lib/observability

Timing and violation instrumentation -- callable from any pipeline stage
without domain context.

## Files

- `stage-timing.ts` -- pure per-stage timing helper for the Strategist
  pipeline (`job_strategist_pipeline_stage_seconds{stage}`); clock is
  injected so tests never depend on real wall-clock time.
- `violation-log.ts` -- collects every guard-violation (stage, code) pair
  fired during a run so it can be persisted, not just counted; short-lived
  Job pods lose Prometheus counter increments to scrape timing, so
  `run-pipeline` stashes this log on `pipeline_runs.metadata.guard`.

## Invariant

Both modules are pure record-keeping: they observe and report, they never
alter pipeline behaviour or gate a decision. Neither may depend on any other
domain folder's types.

## Adding a file here

Add to `observability/` if the file is a stage-agnostic timing or
instrumentation helper callable from any pipeline without pulling in domain
context (resume, coach, grounding). If it enforces a truthfulness rule rather
than just recording one, it belongs in `grounding/` or `resume/` instead.
