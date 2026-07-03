---
id: constraints/gap-awareness
version: 1
cachePoint: none
---
================================================================================
SOURCE: resume/gap-awareness.md
================================================================================

# Gap Awareness

What is NOT in the portfolio and why. Overclaiming on any of these points risks rejection or failed technical screens.

## Context Boundaries

| Context Factor | Portfolio Reality | Honest Framing |
|---|---|---|
| Traffic | ~100 daily visitors | "Portfolio-scale" |
| Team size | Solo | "Solo-built" or "independently designed and implemented" |
| SLA | Best-effort | Do NOT claim SLA compliance |
| On-call | No formal on-call | Do NOT claim on-call experience |
| Incident response | Self-directed | "Solo incident response" |
| Budget | Personal AWS account | "Cost-optimised" not "FinOps at scale" |

## Infrastructure Gaps (G1–G8)

| Gap | What's Missing | Risk if Claimed |
|---|---|---|
| G1 | Automated DORA metric collection | DORA numbers are estimates, not dashboards |
| G2 | Post-deploy smoke tests | CDK tests don't verify live cluster health |
| G6 | NetworkPolicy enforcement (partial) | Calico deployed; no cluster-wide default-deny |

## What Was NOT Built

Do NOT claim these:

- **GKE / AKS**, never used. (EKS WAS built — it is the current platform after the kubeadm migration; claim it as current, never as "not built".)
- **Terraform**, CDK only; can say "familiar with Terraform concepts, implemented IaC via CDK"
- **Helm chart authoring from scratch**, used existing charts; "configured and customised third-party Helm charts"
- **Service mesh (Istio, Linkerd)**, Traefik v3 provides L7 ingress. NEVER use "service mesh". Use "Traefik v3 ingress and cross-namespace routing" instead. No mTLS between pods.
- **Multi-region active-active**, single-region (eu-west-1) with edge stack in us-east-1 for CloudFront only
- **Fine-tuning / RLHF**, Bedrock API only; no model training
- **Formal SLOs**, threshold-based alerting; no error budgets or burn-rate alerts
- **Commander.js CLI**, justfile task runner + TypeScript. Do NOT claim Commander.js.
- **GCP / GKE / Google Cloud**, ABSENT from the portfolio (AWS-native). Do NOT mention them and do NOT frame them as in-progress or onboarding.
- **Large-scale multi-node clusters**, dual-pool cluster (general t3.small 1–4, monitoring t3.medium 1–2)

**General evidence gate, applies to all IN_PROGRESS gap entries:**
| Evidence available | What agent may say |
|---|---|
| Confirmed activity in KB | Name only the specific confirmed activities |
| No confirmed activity | Omit the skill entirely; do not mention it and do not state any forward-looking acquisition (no "beginning", "onboarding", or "pursuing" framing for a skill the candidate lacks) |

## What Was Built That's Unusual (Highlight These)

- Self-hosted Kubernetes without managed services, shows depth
- End-to-end observability from OS metrics to distributed traces to RUM
- Three distinct LLM system patterns, most engineers have zero production-pattern AI experience
- Reactive autonomous agent with real write access, not a toy chatbot
- 265+ IaC test assertions, most infrastructure code is untested

