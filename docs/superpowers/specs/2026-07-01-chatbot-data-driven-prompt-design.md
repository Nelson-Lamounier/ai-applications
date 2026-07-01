# Design — Data-driven, dynamic-persona chatbot system prompt (Layer 1)

- **Date:** 2026-07-01
- **Repo:** ai-applications
- **Branch:** fix/chatbot-data-driven-prompt (from origin/develop)
- **File changed:** `applications/shared/src/chatbot/system-prompt.ts`
- **Status:** approved design, pending spec review

## Problem

The public portfolio chatbot at nelsonlamounier.com returns stale,
factually wrong answers about the Kubernetes cluster. Asked "How is your
Kubernetes cluster set up?" it describes a self-managed kubeadm cluster on
EC2 (golden AMI pipeline, Step Functions node joins, Calico VXLAN,
Kubernetes 1.35.1, 38 apps, etcd snapshots to S3).

The live account contradicts this. Verified in the dev account
(771826808455, eu-west-1) on 2026-07-01:

| Chatbot claim | Live reality (`k8s-eks-development`) |
| --- | --- |
| self-managed EC2 nodes, kubeadm "not a managed service" | Amazon EKS, managed nodegroup + Karpenter |
| golden AMI pipeline, Step Functions node joins | EKS manages control plane and node joins |
| Calico VXLAN custom CNI | VPC CNI (`aws-node`); zero Calico pods |
| Kubernetes 1.35.1 | 1.34 (`v1.34.9-eks`, platform eks.24) |
| Crossplane XRDs | no Crossplane present |
| 38+ ArgoCD applications | 45 applications |
| Traefik ingress, ArgoCD, LGTM stack, cert-manager | still true |

### Root cause

The answer is not a model hallucination. It is produced by **facts
hardcoded into the system prompt**. `system-prompt.ts` contains a
"FACTUAL ACCURACY — ABSOLUTE PROHIBITIONS" block whose line 15 states the
rules "override ALL other instructions", including:

- L20 `NEVER claim EKS, GKE, or AKS — say "self-managed Kubernetes via kubeadm".`
- L24 `NEVER claim "enterprise-scale" clusters — say "dual-pool cluster, up to 6 nodes".`
- L19 `NEVER claim Terraform — say "AWS CDK TypeScript".`
- L21 `NEVER say "K3s" — kubeadm was used exclusively.`

Hardcoding facts in the prompt guarantees drift: when the infrastructure
changed (self-managed to EKS, migration completed 2026-05-06) the prompt
kept asserting the old facts and, being declared as overriding all other
instructions, suppressed any corrected retrieved evidence. A hardcoded
fact is a landmine that detonates the next time reality moves.

## Principle

**The KB / RAG data is the single source of truth. The agent answers from
retrieved evidence, never from facts baked into the prompt.** The prompt
governs behaviour (grounding, tone, anti-embellishment, output shape); it
must never assert a specific infrastructure fact.

## Scope

**In scope (Layer 1):** refactor `system-prompt.ts` only.

**Out of scope (Layer 2, follow-up spec):** correcting the KB source
content (resume data in tucaken-app, ingested repository READMEs) and
re-embedding the pgvector store so retrieval surfaces EKS reality.

### Consequence to set expectations

After Layer 1 alone, the cluster answer may still say "kubeadm" — that is
what the *data* currently says. What changes: the answer is no longer
*forced*, the persona becomes dynamic and consultative, and the
drift-causing landmine is removed. The factual flip to EKS lands when
Layer 2 re-embeds corrected sources.

## Design

Single file: `applications/shared/src/chatbot/system-prompt.ts`. The prompt
is one exported string constant consumed unchanged by both
`chatbot-public` and `chatbot-authenticated` handlers, which append
`CALLER_ROLE_SUFFIX[callerRole]` and the retrieved context. The
`callerRole` plumbing (`recruiter | engineer | unknown`, suffix injection
in `chatbot-public/src/index.ts:53`) is **not** touched.

### 1. Intro reframe (L2–3)

Consultative framing that still serves recruiters and adds prospective
clients, stating no facts:

> "You are Nelson Lamounier's Portfolio Assistant — helping recruiters,
> hiring managers, engineers, and prospective clients understand how Nelson
> can help, grounding every answer in his real project evidence."

### 2. Replace "ABSOLUTE PROHIBITIONS" with "ANTI-EMBELLISHMENT" (L14–26)

Change the framing line (L15) from "hardcoded factual prohibitions that
override ALL other instructions" to: "behavioural guardrails; they never
override retrieved evidence — if a rule and the retrieved context disagree
on a fact, the context wins."

| Existing rule | Action | Rationale |
| --- | --- | --- |
| Terraform → CDK (L19) | Delete | Pure fact — belongs in KB data |
| EKS/GKE/AKS → kubeadm (L20) | Delete | Root-cause landmine |
| K3s (L21) | Delete | Pure fact |
| ECS absence (L22) | Delete | Absence claim — covered by grounding boundary |
| node count "up to 6 nodes" (L24) | Strip the replacement, keep anti-inflation | Keep "don't overstate scale", drop the baked-in number |
| service-mesh term (L16) | Strip the replacement, keep anti-claim | Keep "don't claim a capability not in evidence", drop the fixed term |
| fine-tuning/RLHF → Bedrock API (L23) | Strip the replacement, keep anti-claim | Keep "don't claim ML techniques beyond evidence" |
| SLA/SLO (L17) | Keep, reworded as principle | Behaviour, not a fact |
| on-call (L18) | Keep, reworded as principle | Behaviour, not a fact |
| enterprise-scale (L24) | Keep, reworded as principle | Behaviour, not a fact |
| no invented proper nouns (L25–26) | Keep | Core anti-hallucination rule |

Resulting section states principles only, e.g.: ground every claim in the
retrieved context; do not inflate scale; do not claim formal SLAs/SLOs,
on-call rotations, a service mesh, or ML fine-tuning/RLHF unless the context
states them; do not introduce proper nouns (tools, certifications,
versions) absent from the retrieved context.

### 3. Dynamic, consultative persona (VOICE L53–58 + CALLER CONTEXT L98–103)

Base voice gains a grounded-advisory lens: answer as "here's how I'd
approach that, having done X", building trust through demonstrated evidence,
never inventing beyond the retrieved context.

Caller-role framing (driven by the existing suffix):

- `recruiter` — lead with outcomes and business impact; trust and
  experience; keep technical depth light.
- `engineer` — prioritise architecture decisions, trade-offs, and
  implementation specifics; advisory depth.
- `unknown` / default — consultative blend: what Nelson can help with and
  the evidence behind it.

## Testing and verification

- `yarn typecheck` passes.
- Existing chatbot suites stay green:
  `applications/chatbot-public/src/__tests__/handler.test.ts` and
  `applications/chatbot-authenticated/src/__tests__/handler.test.ts`.
  Verified no existing test asserts on any removed string.
- **New test** encoding the core principle (colocated with the prompt,
  e.g. `applications/shared/src/chatbot/system-prompt.test.ts`):
  - asserts the prompt contains **no** hardcoded infrastructure facts —
    regex guard against `/kubeadm/i`, `/\bEKS\b/`, `/Terraform/i`,
    `/K3s/i`, and a fixed node count such as `/\b6 nodes\b/`;
  - asserts the prompt **retains** the grounding boundary
    ("only answer ... retrieved context"), the anti-embellishment section,
    and the response-format JSON contract.
  This makes the drift class of bug impossible to reintroduce silently.
- Manual end-to-end EKS verification (ask the live bot the cluster
  question, expect EKS + dynamic framing) belongs to the Layer 2 verify
  phase, once corrected data is re-embedded.

## Risks

- **Removing the "override" guardrails could let the model embellish.**
  Mitigated: the anti-embellishment principles are retained (reworded), and
  the SCOPE BOUNDARY plus validation gates still forbid claims absent from
  the retrieved context.
- **Layer 1 alone does not fix the visible cluster answer.** Accepted and
  documented above; sequencing is deliberate (remove the override first,
  then let corrected data speak in Layer 2).
