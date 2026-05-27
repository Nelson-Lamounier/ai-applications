---
title: MCP-native tool-use for self-healing, not Bedrock Agent action groups
type: decision
tags: [bedrock, mcp, agentic-ai, agent, action-groups, architecture]
sources:
  - applications/self-healing/src/index.ts
  - infra/lib/stacks/self-healing/gateway-stack.ts
created: 2026-05-27
updated: 2026-05-27
---

## Status

Accepted — implemented as-deployed. The self-healing agent calls
Bedrock `ConverseCommand` directly and discovers its tool catalogue
at every cold start via the MCP Gateway's `tools/list` JSON-RPC
endpoint
([applications/self-healing/src/index.ts:651-705](../../applications/self-healing/src/index.ts#L651-L705)).
No Bedrock Agent + action-group composition is used for this
service.

## Context

The self-healing agent (see [docs/projects/self-healing.md](../projects/self-healing.md))
needs a Bedrock-backed remediation agent that:

- Has access to 10 tools today (cluster inspection, alarm diagnosis,
  node remediation, Argo/cert-manager checks, security-group
  audit) — see [docs/concepts/self-healing-agent.md#dynamic-tool-discovery](../concepts/self-healing-agent.md#dynamic-tool-discovery).
- Will gain or lose tools as the platform's cluster topology
  evolves — new node-pool types, new failure modes, new diagnostic
  endpoints.
- Must enforce per-tool safety policies (DRY_RUN gating on write
  tools, verification enforcement after a write, write-tool
  reflection — see [the concept doc](../concepts/self-healing-agent.md#write-and-verify-enforcement)).

AWS offers two distinct mechanisms for this on Bedrock:

1. **Bedrock Agent + Action Group** — declare an agent resource in
   the account, attach action groups (Lambda-backed tool catalogues)
   to it, invoke via `InvokeAgent`. AWS handles the orchestration.
2. **Bedrock Runtime + ConverseCommand + tool-use blocks** — call
   the model directly with a `toolConfig` parameter; the model
   returns `tool_use` blocks; the caller invokes the tools and
   feeds results back. The MCP (Model Context Protocol) layer fits
   on top of this — the caller can populate `toolConfig` from a
   `tools/list` RPC.

The MCP path is what
[applications/self-healing/src/index.ts](../../applications/self-healing/src/index.ts)
implements.

## Decision

**Use MCP-native tool-use via Bedrock Converse + an AgentCore
Gateway** rather than Bedrock Agent action groups.

Concretely:

- The agent Lambda calls `bedrock:Converse` directly
  ([index.ts:1052-1071](../../applications/self-healing/src/index.ts#L1052-L1071)).
- At cold start, the Lambda issues a `tools/list` JSON-RPC against
  the [AgentCore MCP Gateway](../concepts/mcp-gateway-integration.md)
  to discover the tool catalogue
  ([index.ts:651-705](../../applications/self-healing/src/index.ts#L651-L705)).
- When the model emits a `tool_use` block, the Lambda invokes the
  tool via `tools/call` on the same Gateway
  ([index.ts:722-765](../../applications/self-healing/src/index.ts#L722-L765)).
- Safety policies (DRY_RUN, write-tool reflection, verification
  enforcement) live in the agent Lambda, **not** in the tool
  Lambdas. The Gateway treats every tool uniformly.
- The Gateway is its own CDK stack
  ([infra/lib/stacks/self-healing/gateway-stack.ts](../../infra/lib/stacks/self-healing/gateway-stack.ts))
  separate from the Agent stack, so tools can be added/removed by
  deploying the Gateway alone.

## Consequences

**Enabled:**

- **Independent tool-catalogue evolution.** A new tool ships by
  deploying the Gateway stack. The agent Lambda's deploy is not
  required — the next cold start picks up the new tool via
  `tools/list`. The
  [self-healing concept doc](../concepts/self-healing-agent.md#tradeoffs)
  records this as a primary motivation.
- **Safety policies live in the agent, not the tool catalogue.**
  DRY_RUN gating, the write-tool reflection prompt
  ([index.ts:1185-1190](../../applications/self-healing/src/index.ts#L1185-L1190)),
  and verification enforcement
  ([index.ts:1210-1232](../../applications/self-healing/src/index.ts#L1210-L1232))
  are agent-Lambda code. They apply uniformly to every tool the
  Gateway exposes, including tools that didn't exist when the
  Lambda was last deployed.
- **Fallback to a hardcoded tool set** on Gateway outage
  ([index.ts:777-898](../../applications/self-healing/src/index.ts#L777-L898)).
  A Gateway failure degrades capability but does not break the
  agent. Bedrock Agent action groups don't naturally support this
  failover; the agent resource fails closed.
- **No per-account Bedrock Agent resource** to manage. The Bedrock
  Agent resource type carries its own quotas, deploy semantics, and
  IAM scoping. Skipping it removes that complexity.

**Prevented:**

- AWS-managed orchestration. The agent Lambda has to implement the
  Converse loop, the iteration cap (MAX_ITERATIONS = 10), the
  token budget gate (MAX_TOKENS_PER_INVOCATION = 20,000), the
  sliding-window history truncation. Bedrock Agent would have
  handled the first two on its side.
- Action-group-level IAM scoping. With Bedrock Agent, each action
  group can have its own execution role. With MCP, every tool runs
  under the Gateway's Lambda IAM, and per-tool isolation is the
  Gateway's job.

**New problems / accepted residual:**

- **Agent loop is hand-rolled.** ~250 lines of Converse loop code
  in
  [index.ts:1024-1249](../../applications/self-healing/src/index.ts#L1024-L1249).
  Bedrock Agent would have hidden this. The accepted residual: the
  loop is testable, the safety policies are explicit, the
  iteration semantics are auditable line-by-line.
- **`tools/list` and `tools/call` are Cognito-protected.** OAuth2
  client credentials grant + cached client secret resolution at
  cold start
  ([index.ts:563-637](../../applications/self-healing/src/index.ts#L563-L637)).
  Bedrock Agent would have used AWS-native IAM directly. The MCP
  path adds Cognito as a dependency.

## Alternatives considered

### Bedrock Agent + Action Group (the default AWS recommendation)

The dominant guidance for Bedrock-backed agents. Rejected because:

- **Tool catalogue is baked into the agent resource.** Adding a
  tool requires deploying both the action group AND the agent
  (the agent has to be updated to reference the new action group's
  ARN). MCP separates the two.
- **No per-tool DRY_RUN gating without re-implementing it inside
  each tool Lambda.** The "default off" stance for write operations
  is a property of the *agent*, not the *tool* — and Bedrock Agent
  doesn't surface that distinction.
- **Fallback semantics are weak.** A misconfigured action group
  makes the agent fail closed; there's no equivalent of "the
  Gateway is down, fall back to the hardcoded tool list."

### Bedrock Runtime + hardcoded tools (no MCP)

The agent Lambda could declare its tool catalogue in code and skip
the Gateway entirely. Rejected because:

- **Every tool change is an agent Lambda deploy.** Loses the
  primary benefit of the MCP path.
- **Tools live in the same process as the agent.** A misbehaving
  tool (memory leak, slow kubectl) directly hurts the agent's
  10-minute Lambda budget. Separating tools into their own
  Lambdas behind the Gateway gives per-tool isolation.

### Custom orchestrator (Step Functions, EventBridge Pipes, etc.)

Considered for the broader "infrastructure remediation" surface,
not the agent itself. Step Functions runbooks per failure class
was an early candidate; rejected because new failure patterns
require code, and the diagnostic step is exactly where LLMs are
good. See [ADR 0001](0001-deterministic-over-llm-extraction.md)
for the inverse case (where determinism *was* the right answer).

## Implementation in this codebase

The concrete artefacts of this decision:

- [applications/self-healing/src/index.ts](../../applications/self-healing/src/index.ts)
  — the Converse-loop agent Lambda
- [infra/lib/stacks/self-healing/gateway-stack.ts](../../infra/lib/stacks/self-healing/gateway-stack.ts)
  — the AgentCore Gateway CDK stack
- [applications/self-healing/src/tools/](../../applications/self-healing/src/tools/)
  — 10 tool Lambdas registered with the Gateway
- [docs/concepts/mcp-gateway-integration.md](../concepts/mcp-gateway-integration.md)
  — the MCP-side architecture in detail
- [docs/concepts/self-healing-agent.md](../concepts/self-healing-agent.md)
  — the agent side: prompt augmentation, safety enforcement,
  cost gates

## How this relates to the other ADRs

- [ADR 0001](0001-deterministic-over-llm-extraction.md) — the
  inverse trade. Tech-extractor decommissioned an LLM because a
  parser was viable. Self-healing keeps the LLM because no parser
  alternative exists for the diagnose-then-classify-then-remediate
  workflow.
- [ADR 0002](0002-pgvector-over-pinecone-for-cache.md) — the
  asymmetric split-vector-store decision. Different shape, same
  principle: pick the integration that matches the workload, not
  the AWS default.

<!--
Evidence trail (auto-generated):
- Source: applications/self-healing/src/index.ts (read in full prior session; lines 651-705, 722-765, 777-898, 1024-1249, 1185-1190, 1210-1232 cited)
- Source: infra/lib/stacks/self-healing/gateway-stack.ts (read prior session)
- Cross-references: docs/concepts/self-healing-agent.md, docs/concepts/mcp-gateway-integration.md, docs/projects/self-healing.md (all on develop after PR #70 merge)
-->
