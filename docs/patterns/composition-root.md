---
title: Composition root per service entry point
type: pattern
tags: [architecture, dependency-injection, k8s-job, lambda, observability, testability]
sources:
  - applications/ingestion/src/run-ingestion.ts
  - applications/job-strategist/src/run-pipeline.ts
  - applications/article-pipeline/src/run-pipeline.ts
  - applications/tech-extractor/src/run-tech-extract.ts
  - applications/self-healing/src/index.ts
  - applications/chatbot-public/src/index.ts
created: 2026-05-27
updated: 2026-05-27
---

## Intent

Concentrate all dependency wiring — pool construction, secret
resolution, repository/agent instantiation, observability bootstrap
— in a **single file per service**. The wiring file is the
*composition root*: every other module in the service takes its
dependencies as constructor arguments or function parameters; nothing
else imports `pg.Pool`, `BedrockRuntimeClient`, or `ioredis`.

This makes every service's `main()` a sequence of: parse env →
instantiate primitives → call orchestrator. Tests of business logic
never need to construct a pool or a Bedrock client; they pass
in-memory stubs into the same orchestrator.

## When to apply

**Use this pattern when:**

- A service has more than one persistence or external-IO dependency
  (e.g. Aurora + Bedrock + Redis + S3 in a single Lambda).
- Some dependencies are **module-scoped for warm-instance reuse**
  (Lambda) vs **per-invocation** (K8s Job).
- Different environments need different wiring (dev/staging/prod
  via env vars only — no code change).

**Do not apply when:**

- The service is a single file with one external dependency. The
  ceremony costs more than the benefit.
- The service is a pure CLI script with no testable business logic
  to extract.

## Structure

```mermaid
flowchart TD
    Env[parseEnv<br/>env.ts] --> Main[main()]
    Main --> Pool["new Pool(env.pg)"]
    Main --> Obs["bootstrapK8sObservability(<br/>{ serviceName })"]
    Main --> Repos[Instantiate<br/>Rds*Repository<br/>via interfaces]
    Main --> Agents[Instantiate<br/>Bedrock-backed<br/>synthesizers + verifiers]
    Repos --> Orch[Orchestrator fn<br/>e.g. refreshUserProfileRollup]
    Agents --> Orch
    Pool --> Repos
    subgraph "Module scope (warm-reusable)"
        Scrub["new PiiScrubber()"]
        Cache["PgSemanticCache.fromEnvironment()"]
        Verif["new BedrockGroundingVerifier(<br/>{ mode: 'block' })"]
    end
    Scrub --> Main
    Cache --> Main
    Verif --> Main
```

### Variant 1 — K8s Job entry point

Two sub-shapes in the codebase:

- **Single-pass jobs** (`run-ingestion.ts`, `run-tech-extract.ts`):
  `parseEnv` → open pool → instantiate repos + agents → run
  orchestrator → push final metrics → close pool → exit with
  status code.
- **Pipeline jobs** (`run-pipeline.ts` in job-strategist +
  article-pipeline): same scaffold but with pipeline-runs state
  machine writes between agent steps.

The
[applications/job-strategist/src/run-pipeline.ts](../../applications/job-strategist/src/run-pipeline.ts)
header documents the K8s Job variant explicitly:

> Strategist analysis K8s Job entrypoint — replaces the
> Trigger / Research / Strategist / Resume-builder / Analysis-persist
> Lambda chain orchestrated by Step Functions.

The previous architecture was **Lambda chain + Step Functions**;
the move to a K8s Job-with-composition-root condensed that into a
single process with one composition point.

### Variant 2 — Lambda entry point

For Lambda services
([applications/chatbot-public/src/index.ts](../../applications/chatbot-public/src/index.ts),
[applications/chatbot/src/index.ts](../../applications/chatbot/src/index.ts),
[applications/self-healing/src/index.ts](../../applications/self-healing/src/index.ts)),
the composition root is split:

- **Module-scoped instances** (held across warm invocations):
  ```ts
  const piiScrubber = new PiiScrubber();
  const groundingVerifier = new BedrockGroundingVerifier({ mode: 'block' });
  const semanticCache = PgSemanticCache.fromEnvironment();
  ```
  These survive between Lambda invocations and amortise their
  construction cost.
- **Per-invocation construction inside `handler`** — only data
  that depends on the event (the user id, the alarm name).

The pattern is visible identically in `chatbot/`, `chatbot-public/`,
`chatbot-authenticated/`, `self-healing/`, and `outcome-tracker.ts`.

### What lives at module scope vs inside `main()` / `handler`

| Thing | Where | Why |
| :- | :- | :- |
| `PiiScrubber` | Module scope | Regex compiles once; no per-call cost worth optimising |
| `PgSemanticCache.fromEnvironment()` | Module scope | Embeds a `pg.Pool` + `BedrockRuntimeClient`; both are pool/connection-reuse friendly |
| `BedrockGroundingVerifier` | Module scope | Holds a `BedrockRuntimeClient` |
| `bootstrapK8sObservability` | Module scope OR top of `main()` | Initialises OTel + EMF + Pushgateway; idempotent in practice |
| `parseEnv()` | Top of `main()` | Throws on missing env — must run after Lambda init so the error surfaces in the invocation, not at cold start |
| Repositories (`new Rds<X>Repository(pool)`) | Inside `main()` / per-invocation | Cheap (just stores the pool); kept close to the orchestrator call for readability |

### Observability is always wired first

Every entry point bootstraps observability before any business
logic:

```ts
const obs = bootstrapK8sObservability({ serviceName: 'article-pipeline' });
const log = obs.logger;

const pipelineRuns = new Counter({
    name: 'article_pipeline_runs_total',
    help: 'Article pipeline Job runs by terminal outcome.',
    labelNames: ['outcome'] as const,
    registers: [obs.registry],
});
```

This means **any subsequent failure** is captured: a `parseEnv()`
throw, a pool-open failure, an agent crash. The metrics + tracing
infrastructure must be alive before the failure can be recorded.

## Implementation in this codebase

| Service | Entry point | Variant |
| :- | :- | :- |
| ingestion | [applications/ingestion/src/run-ingestion.ts](../../applications/ingestion/src/run-ingestion.ts) | K8s single-pass |
| tech-extractor | [applications/tech-extractor/src/run-tech-extract.ts](../../applications/tech-extractor/src/run-tech-extract.ts) | K8s single-pass |
| ontology-importer | [applications/ontology-importer/src/run-import.ts](../../applications/ontology-importer/src/run-import.ts) | K8s single-pass |
| job-strategist | [applications/job-strategist/src/run-pipeline.ts](../../applications/job-strategist/src/run-pipeline.ts) | K8s pipeline |
| article-pipeline | [applications/article-pipeline/src/run-pipeline.ts](../../applications/article-pipeline/src/run-pipeline.ts) | K8s pipeline |
| chatbot (managed agent) | [applications/chatbot/src/index.ts](../../applications/chatbot/src/index.ts) | Lambda |
| chatbot-public | [applications/chatbot-public/src/index.ts](../../applications/chatbot-public/src/index.ts) | Lambda |
| chatbot-authenticated | [applications/chatbot-authenticated/src/index.ts](../../applications/chatbot-authenticated/src/index.ts) | Lambda |
| self-healing agent | [applications/self-healing/src/index.ts](../../applications/self-healing/src/index.ts) | Lambda |
| self-healing outcome-tracker | [applications/self-healing/src/outcome-tracker.ts](../../applications/self-healing/src/outcome-tracker.ts) | Lambda |

Ten composition points across nine services. Every one follows the
same scaffold modulo K8s-vs-Lambda lifetime differences.

## Variants

### Pool lifecycle

K8s Jobs **open and close** their pool inside `main()`:

```ts
const pool = getPool();
try {
    await main(pool);
} finally {
    await closePool();
}
```

Lambdas **share** their pool across warm invocations via module
scope. Cold-start cost is amortised; the pool's
`idleTimeoutMillis` handles connection reuse.

### Per-call cost context threading

Several primitives accept an **optional** per-call cost context:

```ts
new TitanEmbeddingProvider(region, dim, costCtx?);
new BedrockGroundingVerifier({ mode: 'block', /* + costCtx via field */ });
```

The composition root passes the `pool` once; the per-call `userId`
is threaded into the orchestrator function as a parameter. Tests
that don't care about cost tracking simply omit the context — the
`recordBedrockCost` call inside the primitive is a no-op without
context.

### Outcome metrics on success and failure

Every K8s Job entry point increments a Prometheus counter labelled
by terminal outcome before pushing final metrics:

```ts
const pipelineRuns = new Counter({
    name: 'article_pipeline_runs_total',
    help: '…by terminal outcome.',
    labelNames: ['outcome'] as const,
    registers: [obs.registry],
});
// …
pipelineRuns.inc({ outcome: 'success' });
// or
pipelineRuns.inc({ outcome: 'failed' });
// then
await pushFinalMetrics(obs);
```

This ensures the Job's exit is observable: a missing `success`
increment plus a non-zero `failed` count is the operator's signal.

## Deeper detail

- [docs/patterns/hexagonal-rds-architecture.md](hexagonal-rds-architecture.md)
  — the composition root is where the I-interfaces get bound to
  their concrete Rds-implementations.
- [docs/patterns/per-transaction-rls.md](per-transaction-rls.md) —
  the transactional scaffold that every `Rds<X>Repository` instance
  uses; happens *inside* the repository, not at the composition
  root.
- [docs/concepts/bedrock-cost-tracking.md](../concepts/bedrock-cost-tracking.md)
  — the per-call `TitanCostContext` / `GroundingCostContext` that
  the composition root forwards.
- (planned) docs/patterns/k8s-job-vs-lambda.md — the lifetime
  differences that drive the K8s-vs-Lambda variant split.

## Related concepts

- [docs/concepts/self-healing-agent.md](../concepts/self-healing-agent.md)
  — the most complex Lambda composition root in the codebase
  (module-scoped Bedrock client + Cognito client + S3 + DynamoDB
  + SSM + SNS).
- [docs/concepts/profile-synthesis-chain.md](../concepts/profile-synthesis-chain.md)
  — the largest K8s Job composition root (4 repositories + 4
  synthesizers + 1 narrator + 2 deterministic functions + 1
  orchestrator).

<!--
Evidence trail (auto-generated):
- Source: applications/ingestion/src/run-ingestion.ts (lines 1-50 on 2026-05-27)
- Source: applications/job-strategist/src/run-pipeline.ts (lines 1-40 on 2026-05-27)
- Source: applications/article-pipeline/src/run-pipeline.ts (lines 1-40 on 2026-05-27)
- Source: applications/tech-extractor/src/run-tech-extract.ts (lines 1-50 on 2026-05-27)
- Source: applications/self-healing/src/index.ts (read in prior session)
- Source: applications/chatbot-public/src/index.ts (referenced by bedrock-rag-surface concept doc)
-->
