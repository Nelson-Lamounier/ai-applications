---
id: constraints/role-archetypes
version: 1
cachePoint: none
---
================================================================================
SOURCE: resume/role-archetypes.md
================================================================================

# Role Archetypes

Per-role emphasis maps. When given a job description, identify the archetype, pull bullets from achievements, apply concept-to-resume language, and respect gap-awareness. Adapt emphasis, never invent new claims.

## Archetype 1: Platform / Infrastructure Engineer

**Lead with:** 10-stack CDK architecture, lifecycle-separated stacks, 265+ CDK assertions, data-driven config (19 SG rules from one file)
**Gaps to acknowledge:** single-AZ, portfolio scale, solo-operated.

## Archetype 2: Site Reliability Engineer (SRE)

**Lead with:** DORA baselines, self-healing reactive agent, disaster recovery (etcd + PKI to S3, RTO ~5–8 min), dual-layer observability
**Gaps to acknowledge:** DORA numbers are estimates (G1), no formal SLA, solo on-call.

## Archetype 3: Senior Full-Stack Engineer

**Lead with:** Yarn 4 monorepo (Next.js 15 + TanStack Start), type-safe RPC via createServerFn, Cognito PKCE auth, Blue/Green via Argo Rollouts
**Gaps to acknowledge:** portfolio traffic, no team-scale PR workflow.

## Archetype 4: AI / ML Engineer

**Lead with:** Three distinct Bedrock patterns (Deterministic Workflow, Managed RAG, Reactive Autonomous), Extended Thinking, prompt caching (~90% cost reduction), Guardrails
**Gaps to acknowledge:** no model fine-tuning, no self-hosted inference, DORA numbers are estimates.

## Archetype 5: DevOps / Cloud Engineer

**Lead with:** 22+ GitHub Actions workflows, OIDC-based AWS auth, 10 custom Checkov rules, justfile task runner, Spot instances
**Gaps to acknowledge:** single environment (dev), solo-maintained, portfolio traffic.

## Archetype 6: Operations Engineering / Internal Tooling

**Triggered when JD contains:** "internal tools", "automated frameworks", "operational excellence", "playbooks", "data center", "server operations", "workflow execution", "supply chain software", "process standardisation", "scripting", "Python automation", "operational debugging", "interdependencies"

This archetype takes priority over Full-Stack and DevOps when the role is internal-facing.

**Lead with (priority order):**
1. Python/Bash automation system, case distribution, ROI analysis, business case, EMEA-to-global rollout
2. Operational playbooks and runbooks, structured processes adopted team-wide
3. Kubernetes operational depth, bootstrap automation (Step Functions + SSM + Python)
4. Root cause methodology, log correlation, distributed tracing, systematic diagnosis

**Exclude entirely:** Next.js, React, Tailwind, DynamoDB single-table design, HMAC token verification, Serverless REST API design
**Skills lead:** Scripting & Operational Tooling, Python first, then Bash, AWS CLI, kubectl
**Summary framing:** Lead with systematic troubleshooting and automation depth, not cloud architecture.

Example opener:
> "Infrastructure automation engineer with 3+ years diagnosing and resolving AWS production escalations, systematically debugging across IAM, compute, and networking layers and documenting findings as operational runbooks. AWS Certified DevOps Engineer – Professional. Built Python/Bash automation tooling eliminating 10–20 hours/week of manual workflow overhead."

**Gaps to acknowledge:** solo-operated, automation system pending security approval.

## Archetype 7: Technical Support / Customer Engineering

**Triggered when JD contains:** "support", "customer service", "SLA", "on-call", "escalations", "queue", "ticketing", "customer success", "technical account", "education on the use of our platforms"

This archetype takes priority over SRE and Operations when the role is customer-facing support or technical account work.

**Lead identity:** Ships production AI systems and applies the same root-cause methodology to customer escalations as to internal infrastructure incidents — backed by real Kubernetes and AWS Bedrock depth. (Capability-led: NEVER open with a job-title noun such as "Support engineer".)

**Lead with (priority order):**
1. Customer-impact and reliability bullets, incident resolution, escalation handling, knowledge-base documentation
2. Kubernetes operational depth, demonstrates the production systems credibility behind customer-facing work
3. AI and automation proof, self-healing reactive agent, observability pipelines, prompt caching
4. Work history beneath the above, production depth validates the support framing

**sectionOrder:** summary, experience, projects, education, skills, certifications
(experience leads; projects surface production credibility before skills)

**Exclude entirely:** Detailed CDK assertions counts, Terraform references, frontend/React bullets, eCommerce metrics
**Skills lead:** lead with the "Support & Troubleshooting" group (per the Technical Skills rule), escalation management, root-cause analysis, SaaS & cloud troubleshooting, SLA / resolution-time ownership, AWS troubleshooting, incident triage, Kubernetes, distributed tracing
**Summary framing:** Lead with customer-impact and reliability; close with a production-systems metric that demonstrates the engineering depth behind the support role.

Example opener:
> "Platform support engineer with 3+ years resolving AWS production escalations across IAM, compute, and networking, systematically debugging distributed systems, authoring operational runbooks adopted team-wide, and building self-healing Kubernetes automation. AWS Certified DevOps Engineer – Professional."

**Gaps to acknowledge:** solo-operated, no formal SLA environment, portfolio-scale traffic.

## Archetype Selector

| JD Signal | Archetype |
|---|---|
| "IaC", "CDK", "Terraform", "platform team" | Platform / Infrastructure |
| "SRE", "reliability", "on-call", "DORA", "MTTR" | SRE |
| "React", "TypeScript", "full-stack", "frontend" | Full-Stack |
| "LLM", "AI", "ML", "Bedrock", "RAG", "agent" | AI / ML |
| "CI/CD", "DevOps", "pipeline", "cloud native" | DevOps / Cloud |
| "internal tools", "automated frameworks", "operational excellence", "playbooks", "data center", "server operations", "workflow execution", "supply chain software", "process standardisation" | Operations Engineering / Internal Tooling |
| "support", "customer service", "SLA", "on-call", "escalations", "queue", "ticketing", "customer success", "technical account", "education on the use of our platforms" | Technical Support / Customer Engineering |
| "staff", "principal", "architect" | Mix archetypes equally, show breadth |

**Google-affiliated disambiguation:**
- "Server Operations", "Data Center Software", "Supply Chain", "operational tooling" → Archetype 6
- "SRE", "Production Engineer", "reliability" → Archetype 2
- "Software Engineer, Cloud AI", "LLM", "Gemini" → Archetype 4
- "Software Engineer, Full Stack" with React/TypeScript → Archetype 3
- "Technical Solutions Engineer", "Customer Engineer", "Support Engineer", "Technical Account Manager" → Archetype 7

