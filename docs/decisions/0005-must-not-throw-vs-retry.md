---
title: Must-not-throw orchestrator vs throw-and-retry for profile synthesis
type: decision
tags: [architecture, resilience, error-handling, multi-agent, postgres-coalesce]
sources:
  - applications/ingestion/src/util/refreshUserProfileRollup.ts
  - applications/ingestion/src/agents/MirrorRevealSynthesizer.ts
  - applications/ingestion/src/agents/DirectionSynthesizer.ts
  - applications/ingestion/src/agents/ReconciliationSynthesizer.ts
  - applications/ingestion/src/agents/DiagnosticNarrator.ts
created: 2026-05-27
updated: 2026-05-27
---

## Status

Accepted — implemented as-deployed. The profile synthesis chain in
[applications/ingestion/src/util/refreshUserProfileRollup.ts](../../applications/ingestion/src/util/refreshUserProfileRollup.ts)
wraps every step in `try { … } catch { … = undefined; }` and persists
the `user_profile_rollup` row via a `COALESCE`-on-undefined `upsert`.
A step failing leaves the previous column value in place. The
orchestrator itself is wrapped in an outer `try/catch` that records
the exception on the OTel span but **never propagates it** to the
ingestion caller — *"a rollup failure MUST NOT break ingestion"*
([refreshUserProfileRollup.ts:4-7](../../applications/ingestion/src/util/refreshUserProfileRollup.ts#L4-L7)).

## Context

The profile synthesis chain runs at the end of every successful
ingestion of a `(userId, repoFullName)` pair. It produces five
optional artefacts that get persisted into the `user_profile_rollup`
row for the user:

- Mirror (identity paragraph)
- Reveal (1-5 evidence-anchored inferences)
- Direction (archetype fit + seniority + whatToDeepen)
- Reconciliation (résumé ↔ GitHub credibility gap)
- Diagnostic (deterministic score + LLM-generated narration)

Each step makes a Bedrock call that can fail for reasons outside
the ingestion's control: Bedrock throttling, Lambda cold-start
timeouts on the synthesizer's compute, transient network issues,
or the synthesizer's own zod parse rejecting a malformed model
output ([zod-tool-use pattern](../patterns/zod-tool-use.md)).

The decision space:

1. **Throw-and-retry.** Step 3 throws → orchestrator aborts →
   ingestion is marked failed → the K8s Job `backoffLimit` retries
   the whole ingestion later.
2. **Must-not-throw with COALESCE preservation.** Step 3 throws →
   orchestrator catches → step 3's local is `undefined` → upsert
   uses `COALESCE` → previous value of the Direction column
   survives. Ingestion is marked successful. The OTel span records
   that Direction wasn't refreshed.
3. **Hybrid.** Some steps must-not-throw, some throw. (E.g.
   Mirror+Reveal optional; Direction mandatory.)

The platform's prior position on this — and the position several
other internal failure modes already encode — favours **option 2**.

## Decision

**Adopt must-not-throw for every step in the synthesis chain.**
Per-step `try/catch` wraps each synthesizer invocation; the catch
arm assigns `undefined` to the step's result local; the final
`upsert` takes every step's result as **optional**; the repository
implementation uses `COALESCE(EXCLUDED.<col>, existing.<col>)` per
column.

The orchestrator itself is wrapped in **another outer `try/catch`**
that records the error on the span and continues — a database error
on the upsert, or any other unexpected throw, must not propagate
into ingestion.

The pattern is documented in
[docs/patterns/must-not-throw-orchestrator.md](../patterns/must-not-throw-orchestrator.md);
this ADR records why the pattern was chosen for *this* path.

## Consequences

**Enabled:**

- **Eventual consistency under partial failure.** A user whose
  Direction synthesizer fails today gets a fresh Mirror, Reveal,
  Reconciliation, Diagnostic — and keeps yesterday's Direction
  until the next ingestion retries. The profile is never empty;
  some fields may be stale.
- **Ingestion does not retry unnecessarily.** A Bedrock hiccup in
  step 4 doesn't trigger a full re-ingestion of the repository
  (which includes file fetches, embedding calls, RDS writes).
  The cost-asymmetry is the deciding factor: a Bedrock retry on
  synthesis is ~1k tokens; a full ingestion retry is ~10k tokens
  + GitHub API calls + RDS pool churn.
- **Span attributes record what ran.** Each refresh emits a span
  with `profile_rollup.synthesized`, `.directioned`, `.reconciled`,
  `.diagnosed` boolean attributes
  ([refreshUserProfileRollup.ts:75-81](../../applications/ingestion/src/util/refreshUserProfileRollup.ts#L75-L81)).
  Silent degradation is **observable** via Grafana / Tempo even
  though it doesn't trigger a Prometheus failure counter.
- **Per-synthesizer degradation contracts are explicit.** Each
  synthesizer defines internally what counts as a valid partial
  result (e.g. Reconciliation: one list empty + the other grounded
  is **VALID**; both empty is `undefined`). The orchestrator only
  observes the `undefined` signal.

**Prevented:**

- A noisy alarm fan-out from transient Bedrock failures. The
  K8s Job's `backoffLimit` is reserved for genuine ingestion
  failures (GitHub auth, RDS connection, file extraction) — not
  for synthesizer hiccups.

**New problems / accepted residual:**

- **Diagnosing "why is my Mirror still showing the old result?"
  requires checking the span.** Two indistinguishable surface
  observations:
  - The synthesizer ran and produced an identical Mirror to the
    previous run.
  - The synthesizer dropped its result, COALESCE preserved the
    previous one.
  The span attributes disambiguate
  ([troubleshooting/profile-synthesis-degraded.md](../troubleshooting/) — planned).
- **Operators cannot opt out of preservation.** A user whose
  synthesizer keeps failing eventually has stale columns; the
  pattern has no "give up and clear the field after N failed
  attempts" semantics. If needed, that's a separate read-side
  policy.
- **No per-step alert on sustained failure.** If MirrorReveal has
  failed 100 times in a row for the same user, no alarm fires.
  Mitigated by the span-attribute dashboard (sustained
  `synthesized=false` rate is the operator's signal). A future
  improvement would emit a Prom counter from the orchestrator on
  per-step undefined; today the trace is the only record.

## Alternatives considered

### Throw-and-retry on every step failure

The dominant default — "fail fast, retry the whole pipeline."
Rejected because:

- The synthesis chain is **downstream of** ingestion's expensive
  steps (file fetch + embedding + RDS writes). Retrying the whole
  ingestion for a synthesis failure is cost-asymmetric.
- Synthesizer failures are **bursty and external** (Bedrock
  throttling, transient zod parse failures). They tend not to
  affect the next run, so retrying immediately just burns the
  same throttling window.
- The user profile already has prior values that are still
  meaningful in the absence of fresh output. Throwing them away
  on every fresh-output failure produces empty fields, not stale
  fields — and an empty profile is worse for the consumer than a
  stale one.

### Per-step retry inside the synthesizer

Each synthesizer retries its own Bedrock call N times with
exponential backoff before throwing. Considered. Rejected because:

- Bedrock's own retry semantics (configurable in the SDK) already
  handle transient errors. A per-synthesizer retry on top of that
  is double-retrying.
- Zod parse failures are not transient — retrying the same model
  output gives the same result. Retry on parse failures wastes
  budget.
- Adds 1 → N latency to every step. The 5-step chain is already
  ~20-40 seconds; N=3 retries per step pushes the worst case to
  several minutes.

### Hybrid (mandatory vs optional steps)

Direction or Diagnostic could plausibly be marked mandatory
(throw-and-retry) while Mirror/Reveal stays optional. Rejected
because:

- The mandatory-step list **changes over time** as the chain
  evolves. Direction was added in SP3 after Mirror+Reveal — at the
  time, Mirror+Reveal was "the new optional step." Today Direction
  is the older one. The "mandatory" label would shift with the
  chain.
- The Diagnostic score is **deterministic** —
  `computeUserDiagnostic` runs even when its inputs are partial.
  Only the *narration* is LLM-generated, and the narration's
  absence is a degradation, not a failure. So the strongest
  candidate for "mandatory" is also the worst fit for "throw."

## Implementation in this codebase

| Concern | Location |
| :- | :- |
| Orchestrator | [applications/ingestion/src/util/refreshUserProfileRollup.ts](../../applications/ingestion/src/util/refreshUserProfileRollup.ts) |
| Per-step try/catch | [refreshUserProfileRollup.ts:40-60](../../applications/ingestion/src/util/refreshUserProfileRollup.ts#L40-L60) |
| COALESCE upsert | inside [RdsUserProfileRollupRepository](../../applications/shared/src/rds/implementations/RdsUserProfileRollupRepository.ts) |
| Outer try/catch | [refreshUserProfileRollup.ts:91-97](../../applications/ingestion/src/util/refreshUserProfileRollup.ts#L91-L97) |
| Span attributes | [refreshUserProfileRollup.ts:75-81](../../applications/ingestion/src/util/refreshUserProfileRollup.ts#L75-L81) |
| Same contract on RetrievalProbe | [applications/ingestion/src/agents/RetrievalProbe.ts](../../applications/ingestion/src/agents/RetrievalProbe.ts) |
| Pattern doc | [docs/patterns/must-not-throw-orchestrator.md](../patterns/must-not-throw-orchestrator.md) |

## How this relates to the other ADRs

- [ADR 0001](0001-deterministic-over-llm-extraction.md) — same
  author, opposite trade. Tech-extractor decommissioned an LLM
  because a parser was reliable enough. Synthesis chain keeps the
  LLM because no parser alternative exists; the cost of keeping
  it is paid via this must-not-throw discipline.
- [ADR 0003](0003-mcp-native-vs-action-groups.md) — the
  **inverse** error-handling stance. Self-healing's agent loop
  does throw on unrecoverable failures (a 500 from the handler is
  a visible operator signal). The two ADRs together mark the
  must-not-throw / throw-loudly boundary: silent degradation is
  acceptable for user-facing identity synthesis (the user sees a
  stale field) but not for cluster remediation (an operator needs
  to know that the agent gave up).

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/src/util/refreshUserProfileRollup.ts (lines 1-100 on 2026-05-27)
- Source: applications/ingestion/src/agents/MirrorRevealSynthesizer.ts, DirectionSynthesizer.ts, ReconciliationSynthesizer.ts, DiagnosticNarrator.ts (read prior session for the pattern's per-step contracts)
- Cross-references: docs/concepts/profile-synthesis-chain.md, docs/patterns/must-not-throw-orchestrator.md, docs/concepts/self-healing-agent.md
-->
