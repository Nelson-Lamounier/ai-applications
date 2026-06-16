---
title: All LLM inference through Bedrock — no vendor-direct APIs
type: decision
tags: [bedrock, finops, cost-tracking, auth, pod-identity, platform-consistency, architecture]
sources:
  - applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts
  - applications/ontology-importer/src/env.ts
  - applications/shared/src/ (recordBedrockCost cost ledger)
created: 2026-06-16
updated: 2026-06-16
---

## Status

Accepted — holds as-deployed. Every LLM call on the platform goes
through AWS Bedrock (Converse for synchronous work, Batch Inference for
bulk). There is no vendor-direct SDK path in source: the
ontology-importer's Anthropic Message Batches classifier was replaced by
[`BedrockBatchClassifier`](../../applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts),
and no `@anthropic-ai/sdk` / `ANTHROPIC_API_KEY` usage remains in any
service source.

> Distilled from the dated design spec
> `docs/superpowers/specs/2026-05-25-ontology-importer-bedrock-batch-design.md`.
> That spec is the point-in-time scaffolding for one migration; this ADR
> records the *durable, platform-wide principle* it crystallised. The
> batch-vs-realtime sub-decision lives separately in
> [ADR 0004](0004-bedrock-batch-over-realtime.md).

## Context

The Tier-2 ontology importer originally shipped its Layer-4 LLM
classification on the **Anthropic Message Batches API** — a sound choice
for the LLM layer *in isolation*, but one that broke three platform
invariants the rest of the system holds:

1. **Cost observability.** Every other model call flows through Bedrock
   and is recorded in the single per-user cost ledger (`recordBedrockCost`,
   `prompt_invocations`) and the per-model Cost Explorer dashboards. An
   Anthropic-direct call lands on a **separate invoice the platform's
   cost tracking cannot see** — a permanent blind spot.
2. **Auth surface.** A vendor-direct API needs a managed API-key secret
   (`ANTHROPIC_API_KEY` in Secrets Manager + an External Secrets sync).
   That sync was itself the deploy blocker (`SecretSyncedError` —
   the import CronJob pod could not start). Bedrock uses IAM / Pod
   Identity, like every other Job — no key to rotate, sync, or leak.
3. **Consistency.** The platform is Bedrock-centric (one PII-scrubber,
   one Guardrail surface, one model registry). A vendor-direct caller is
   a lone outlier every cross-cutting concern has to special-case.

Crucially, there was **no capability gap**: Bedrock runs the same Claude
models, supports tool-use (`tools` / `tool_choice` in the Messages
`modelInput`), and offers Batch Inference for the same ~50% async batch
economics. The vendor-direct path bought nothing the platform didn't
already have through Bedrock — at the cost of three broken invariants.

## Decision

**All LLM inference goes through AWS Bedrock.** No service may call a
model-vendor API directly (Anthropic, OpenAI, etc.).

- Synchronous work uses Bedrock Converse; bulk work uses Bedrock Batch
  (`CreateModelInvocationJob`) — see [ADR 0004](0004-bedrock-batch-over-realtime.md)
  for when each applies.
- Model selection is centralised in the shared model registry, not
  per-service vendor clients.
- Auth is IAM / Pod Identity. No managed model-vendor API-key secrets.
- Every invocation passes through the shared cost ledger and PII scrubber.

## Consequences

**Enabled:**

- **Complete cost observability.** Every token is attributable per user
  and per model in one ledger + the Cost Explorer dashboards. No invoice
  the platform can't see.
- **No API-key secret class.** Removing `ANTHROPIC_API_KEY` removed the
  ESO-sync failure mode (`SecretSyncedError`) that blocked the importer.
  Pod Identity IAM is the same auth every other Job already uses.
- **One cross-cutting surface.** PII scrubbing, Guardrails, model
  registry, and grounding verification apply uniformly — no per-vendor
  special-casing.

**Prevented:**

- Split billing and the cost blind spot a vendor-direct call creates.
- A second auth/secret-management surface per vendor.

**New problems / accepted residual:**

- **Bound to Bedrock's model + region availability.** If a needed model
  ships on a vendor API *before* Bedrock (or never reaches Bedrock), this
  principle conflicts with using it. The accepted stance: wait for
  Bedrock, or re-open this ADR with the specific capability that forces
  the exception — not a blanket vendor-direct allowance.
- Batch adds latency vs a vendor's realtime endpoint; mitigated by the
  Converse/Batch split in ADR 0004.

## Alternatives considered

### Vendor-direct API for a specific capability

Rejected as a default. Only justified if Bedrock genuinely lacks a
required capability — in which case the exception is recorded as its own
ADR naming the capability, not a standing allowance. As of this decision,
no such gap exists (tool-use, batch economics, and the Claude models are
all on Bedrock).

### Keep the ontology-importer on Anthropic Message Batches

The original implementation. Rejected because it bought no capability and
broke the three invariants above — the entire motivation for the
migration.

## How this relates

- [ADR 0004](0004-bedrock-batch-over-realtime.md) — *how* the bulk path
  runs (Batch vs realtime), once the work is on Bedrock.
- The cost ledger + per-model dashboards are the observability this
  principle protects.

<!--
Evidence trail:
- Source check (2026-06-16): no @anthropic-ai/sdk / ANTHROPIC_API_KEY /
  Message Batches in any service *source* (only a stale dist/ artifact).
- Live classifier: applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts
- Distilled from: docs/superpowers/specs/2026-05-25-ontology-importer-bedrock-batch-design.md (## Why)
-->
