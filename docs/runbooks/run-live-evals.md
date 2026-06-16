---
title: Run live evals (RUN_LIVE_EVALS)
type: runbook
tags: [operations, evals, bedrock, finops, job-strategist]
sources:
  - applications/job-strategist/src/evals/research/run-research-eval.ts
  - applications/job-strategist/src/evals/live/run-live-evals.ts
  - applications/job-strategist/src/evals/live/run-refine-eval.ts
created: 2026-06-16
updated: 2026-06-16
---

## When to run this

Run a live eval when you change an LLM-phase prompt or model and need to confirm
real Bedrock output still passes the phase's graders — or to A/B two models
(e.g. Haiku vs Sonnet) over a real job description. Default `jest` and CI **do
not** run these: they are gated behind `RUN_LIVE_EVALS=1` so the test suite never
calls Bedrock and never spends
([run-research-eval.ts:21-25](../../applications/job-strategist/src/evals/research/run-research-eval.ts#L21-L25)).

The deterministic Tier-1 graders already run in CI on every change — see
[per-phase-evals](../concepts/per-phase-evals.md). This runbook is for the live
Tier-2 pass only.

## Prerequisites

- AWS credentials with Bedrock invoke access for the target model(s).
- A real `USER_ID` whose repos are ingested (for runs that retrieve evidence).
- A job-description string (`JD_TEXT`) for research/strategist runs.
- `npx tsx` available in the `job-strategist` workspace.
- Awareness that each run **spends Bedrock tokens** — this is real model traffic,
  not a stub.

## Procedure

Run from the `job-strategist` workspace
(`applications/job-strategist`).

### Research (matcher) eval — single model

```bash
RUN_LIVE_EVALS=1 \
RESEARCH_MODEL=eu.anthropic.claude-sonnet-4-6 \
USER_ID=<dev-user-uuid> \
JD_TEXT="<job description text>" \
npx tsx src/evals/research/run-research-eval.ts
```

### Research eval — Haiku↔Sonnet A/B

Run twice, once per `RESEARCH_MODEL`, and compare the grader reports:

```bash
RUN_LIVE_EVALS=1 RESEARCH_MODEL=eu.anthropic.claude-haiku-4-5-20251001-v1:0 USER_ID=<uuid> JD_TEXT="..." npx tsx src/evals/research/run-research-eval.ts
RUN_LIVE_EVALS=1 RESEARCH_MODEL=eu.anthropic.claude-sonnet-4-6           USER_ID=<uuid> JD_TEXT="..." npx tsx src/evals/research/run-research-eval.ts
```

### Case-study refine eval

```bash
RUN_LIVE_EVALS=1 npx tsx src/evals/live/run-refine-eval.ts
```

### Tier-2 live suite (with LLM judge)

```bash
RUN_LIVE_EVALS=1 npx tsx src/evals/live/run-live-evals.ts
```

## Verification

- The runner prints per-grader pass/fail (`coverage`, `schema`, `grounding`,
  `fitSanity`, `verdictAccuracy` for research). All graders pass = the live output
  honours the same structural contract CI enforces.
- Without the gate set, the runner exits early with
  `RUN_LIVE_EVALS not set — skipping ...` and makes **no** Bedrock call
  ([run-research-eval.ts:25](../../applications/job-strategist/src/evals/research/run-research-eval.ts#L25),
  [run-refine-eval.ts:79](../../applications/job-strategist/src/evals/live/run-refine-eval.ts#L79)) —
  use that to confirm CI safety.
- For an A/B, compare the two grader reports and any judge scores; prefer the
  model that passes the deterministic graders and scores higher on the judge.

## Rollback

These runs are read-only against your code — they invoke Bedrock and grade the
result; they do not write application state. There is nothing to roll back beyond
the (already-incurred) token spend. To stop, omit `RUN_LIVE_EVALS=1` and the
runners no-op.

<!--
Evidence trail (auto-generated):
- Source: applications/job-strategist/src/evals/research/run-research-eval.ts (read on 2026-06-16, gate L21-25, usage L10-13)
- Source: applications/job-strategist/src/evals/live/run-refine-eval.ts (read on 2026-06-16, gate L24, L79)
- Source: applications/job-strategist/src/evals/live/run-live-evals.ts (listed on 2026-06-16, Tier-2 gated runner)
-->
