/**
 * @format
 * Resume Constraints — Static Wiki Content
 *
 * These five pages were previously served deterministically by wiki-mcp via its
 * `/api/constraints` endpoint and `get_resume_constraints` MCP tool. Constraint
 * documents are system-level rules, not candidate-specific portfolio evidence.
 *
 * They MUST be delivered deterministically — vector search with userId metadata
 * filtering cannot retrieve them because they carry no userId attribute in the
 * Pinecone index (they are shared system documents, not per-user vectors).
 *
 * The wiki-mcp design comment said it explicitly:
 * "role-archetypes and achievements are included here (not left to Pinecone)
 *  because archetype selection must be deterministic"
 *
 * This module replaces the wiki-mcp dependency by embedding the five pages
 * as a single static string injected into the strategist pipeline as
 * `resumeConstraints`. Any update to the source wiki pages must be
 * reflected here manually.
 *
 * Source pages (read-only originals in reasearch-brain/kowledge-base/wiki/resume/):
 *   - agent-guide.md     — generation rules, confidence thresholds, hard rules
 *   - gap-awareness.md   — honesty boundaries, what NOT to claim
 *   - voice-library.md   — authentic writing voice, banned terms, anti-AI rules
 *   - role-archetypes.md — per-role emphasis maps, archetype selector
 *   - achievements.md    — canonical quantified numbers and bullet templates
 *
 * Last synced: 2026-04-20
 */

// =============================================================================
// STATIC RESUME CONSTRAINTS
// =============================================================================

/**
 * All five wiki constraint pages concatenated.
 *
 * Injected as `resumeConstraints` in the Research Agent result and forwarded
 * to the Strategist Agent as authoritative generation rules.
 *
 * The strategist agent must treat these as absolute constraints — they override
 * any conflicting inference from KB portfolio evidence or the job description.
 */
export const RESUME_CONSTRAINTS: string = `
================================================================================
SOURCE: resume/agent-guide.md
================================================================================

# Agent Guide — Resume Generation

**Start here.** This is the direct path for AI agents generating resume summaries, achievement bullets, and cover letters from this knowledge base.

## Confidence Thresholds

| Status | What it means | What agents may say |
|---|---|---|
| **STRONG** | Fully implemented with file evidence | Claim directly and confidently |
| **PARTIAL** | Implemented with caveats or missing components | Use \`recommended_framing\` only — never full achievement_pattern |
| **IN_PROGRESS** | Exists but not production-validated | Use "currently implementing" language only |
| **ABSENT** | Not built | Never mention this concept |
| **IMPLIED** | Reasonable inference, not directly evidenced | Mention with hedging language only |

**Confidence score thresholds for archetype selection:**

| Signal strength | Score | Action |
|---|---|---|
| 3+ trigger phrases matched | 0.9+ | High confidence — proceed with archetype |
| 1–2 trigger phrases matched | 0.7–0.8 | Moderate confidence — proceed, flag if ambiguous |
| No clear trigger | 0.5 | Set \`archetype_gap_detected = true\` — use closest match, flag for human review |

## Resume Input Path Handling

**PATH A — No resume provided (default, recommended):**
Generate all content entirely from KB using archetype rules.
No structural constraints from any uploaded document.
This is the preferred path for all new applications — produces the cleanest output with no carry-over artefacts.

**PATH B — Resume provided (formatting reference only):**
The uploaded document is a FORMATTING REFERENCE. It contributes zero content.

Permitted uses:
- Section ordering preference
- Header and contact block format (name, email, location, links)

Prohibited uses (any violation is a fabrication error):
- Copying or paraphrasing any bullet, summary, or project description
- Using the uploaded skills list to select or exclude skills
- Treating any uploaded text as evidence of a claim

**Empty section rule (PATH B):**
If a section exists in the uploaded resume but has no KB evidence, leave that section EMPTY in the output — do not copy from the uploaded document to fill it.

**Archetype ordering rule (PATH B):**
If the uploaded resume structure conflicts with archetype section ordering requirements, the archetype ordering wins.

## Step-by-Step: Resume Summary

**Summary content filter — strict:**
The Professional Summary must only contain concepts that either:
1. Appear in the JD (exact term or close synonym), OR
2. Are tier-1 differentiators for the role type

**JD Signal → Narrative variant quick-map:**

| JD mentions | Use |
|---|---|
| "IaC", "CDK", "platform team", "multi-account" | Platform Engineering narrative |
| "SRE", "MTTR", "incident response", "reliability" | Support-to-DevOps transition + DORA metrics |
| "full-stack", "React", "TypeScript", "frontend" | Full-stack + platform unified narrative |
| "LLM", "AI", "Bedrock", "agent", "RAG" | AI-augmented engineering narrative |
| "DevOps", "CI/CD", "pipelines", "cloud native" | Platform + delivery narrative |
| "staff", "principal", "architect" | Mix all three acts — show breadth |
| "troubleshoot", "customer", "solutions engineer", "escalation", "TSE", "technical support" | Customer-facing infrastructure narrative |
| "internal tools", "automated frameworks", "operational excellence", "playbooks", "data center", "server operations", "workflow execution", "supply chain software", "process standardisation" | Operations engineering narrative — lead with Python/Bash automation |

**Customer-facing infrastructure opener pattern (TSE / Solutions Engineer / Support roles):**
> "Cloud infrastructure engineer with [N] years triaging enterprise [domain] escalations at AWS — debugging across [layers] for production customer environments. [Cert]. [Portfolio differentiator]."
Rules: NEVER open with the certification name. Action-first, not title-first.

**kubeadm differentiator for TSE / Kubernetes roles — MUST articulate the WHY:**
> "kubeadm exposes control plane internals — etcd, kube-apiserver, kubelet, Calico CNI — that managed Kubernetes services abstract away. That is the layer that breaks in production customer escalations."

**Use the managed service name from the JD — never hardcode one:**
| JD mentions | Managed service to name |
|---|---|
| "GKE", "Google Kubernetes Engine" | GKE |
| "EKS", "Amazon EKS" | EKS |
| "AKS", "Azure Kubernetes Service" | AKS |
| No specific service named | "managed Kubernetes services" |

## Step-by-Step: Achievement Bullets

1. Draw from the Achievements page below. Prioritise STRONG concepts.
2. For PARTIAL → use only recommended_framing. For IN_PROGRESS → "currently implementing". For ABSENT → do not generate.
3. Preserve all numbers — never round beyond what's in the achievements list.

**Every bullet describing a technical implementation MUST close with an outcome.**
Format: "[Strong verb] [specific technology + implementation detail], [concrete outcome]"

**Achievement bullet ordering rule — role-type driven:**

Infrastructure/support roles (TSE, SRE, Platform, Solutions, DevOps):
1. Kubernetes operational bullets first (kubeadm, Calico CNI, ArgoCD self-healing)
2. Customer-facing incident triage second
3. IaC and CI/CD third
4. Observability fourth — use Kubernetes-native implementation
5. Serverless, frontend, full-stack bullets EXCLUDED ENTIRELY

Full-stack/product roles:
1. Serverless and API bullets first
2. Frontend or product delivery second
3. CI/CD and IaC third
4. Kubernetes de-prioritised unless JD explicitly mentions K8s

AI/ML engineering roles:
1. Bedrock AI pipelines first
2. CI/CD and IaC second
3. Kubernetes and observability third

Operations Engineering / Internal Tooling roles:
1. Python/Bash automation bullets first — lead with this even if IN_PROGRESS
2. Operational runbooks and knowledge base documentation second
3. Kubernetes operational depth third
4. Root cause methodology fourth
5. Serverless, frontend, full-stack bullets EXCLUDED ENTIRELY
6. CDK bullets de-prioritised — supporting context only

Technical Support / Customer Engineering roles:
1. Customer-impact and reliability bullets first (escalation handling, knowledge-base documentation, resolution timelines)
2. Production systems proof second (Kubernetes operational depth, self-healing, distributed tracing)
3. AI and automation third — demonstrates engineering depth beyond ticket-closing
4. IaC and CI/CD fourth — supporting context
5. Frontend, React, eCommerce bullets EXCLUDED ENTIRELY
6. TRANSLATE transferable skills from ROLE EVIDENCE into support vocabulary when present

**Key Achievements section hard constraints:**
- Maximum 4 bullets. Select the 4 most relevant to JD.
- Maximum 100 words total across all 4 bullets. Count before outputting.

**Numbers safe to claim directly:**
- 25 ArgoCD-managed applications (use "25" not "20+")
- 4 AWS accounts (dev/staging/prod/management)
- 4 Bedrock AI applications
- 265+ CDK test assertions
- 22+ GitHub Actions workflows
- ~90% prompt cache cost reduction (Writer Lambda only — scoped qualifier required)
- DORA metrics (lead time, TTSR, CFR): DO NOT use until real measured values exist. Omit entirely if no concrete value is confirmed.

## Step-by-Step: Key Projects

1. Maximum 2 projects per resume. Select the 2 most relevant to the JD.
2. Apply deduplication — each concept, tool, or number appears in full only once across the entire resume.
3. Never frame a project as "addressing a lack of X" — frame as a deliberate architectural decision.

**Mandatory pre-flight deduplication check — AGENT-INTERNAL ONLY:**
Before drafting the second project, list every concept, tool, and number already used in Key Achievements. CI/CD pipeline detail is the most common failure point.

**Cross-section deduplication rule:**
| Already stated in | Rule for subsequent sections |
|---|---|
| Key Achievements | Projects gets one clause maximum for the same concept |
| Projects | Experience bullets reference it briefly or omit it |
| Summary | Achievements and Projects do not restate the same framing |

## Step-by-Step: Technical Skills

1. Order subsections to mirror JD priority — not alphabetically.
2. Each tool appears in one subsection only.
3. Scripting/tooling subsection mandatory for TSE, SRE, Support, Solutions Engineer roles.
4. GKE onboarding signal: when JD targets GCP and direct GCP experience is absent, add "GKE (actively onboarding)" — do not claim full GKE experience.
5. "portfolio-scale" is BANNED in the Skills section. Never write it.

## Step-by-Step: Cover Letter

Output format: plain prose only. No markdown headings in the output.
1. Open with role identity variant (not cert-first).
2. Use one authentic phrase from Voice Library in the first paragraph.
3. Select 2–3 achievement bullets that map to JD top 3 requirements.
4. Close with the dual-perspective differentiator without capitalised AND.
5. Never close on a gap — close on the strongest claim restated in the language of the role.

**"portfolio-scale" / "solo-operated" ban in cover letters:**
Use "self-managed", "independently built and operated", or "built without a managed service abstraction" instead.

## ATS Optimization Rules

1. Exact keyword matching — use the JD's exact term.
2. Certification names verbatim: \`AWS Certified DevOps Engineer – Professional\` (en-dash).
3. Standard section headers: "Experience", "Skills", "Education", "Certifications".
4. Bullet format: [Strong verb] [specific technology/context] [measurable outcome].
5. No tables inside bullet lists.

## Human-Written Output Rules

1. Before generating any bullet, retrieve a phrase from the Voice Library and use it as an anchor.
2. Banned verbs: spearheaded, leveraged, orchestrated, revolutionized, streamlined, synergized, fostered, utilized.
3. Vary sentence length — mix short (under 12 words), medium, and long.
4. No consecutive same-verb openers.
5. Specific proper nouns over generic descriptions.
6. Cover letters: first-person direct — "I built X" not "X was built".
7. No opener clichés — never start with "I am writing to express my interest in".
8. Capitalised AND for emphasis (e.g. "built the platform AND deployed") is an AI-generation signal — banned.
9. Em dash (—) permitted only in date ranges and role/company separators. All other uses banned.
10. Professional Summary opener — NEVER cert-first. First sentence MUST be a role identity statement.
11. Professional Summary: 100 words maximum. Closing sentence must contain one concrete DORA-flavoured number.

## Resume Word Count Budget — Hard Limits

| Section | Limit |
|---|---|
| Professional Summary | 100 words max |
| Experience (all roles combined) | 370 words max |
| Skills | 150 words max |
| Key Projects (both combined) | 160 words max |
| Key Achievements (all bullets) | 100 words max |
| Education + Certifications + Profile header | ~80 words |
| Grand Total | ~880 words |

After generating all sections, sum the word counts. Do not return an over-budget resume.
Trim order: Experience first → Skills second → Projects third. Never trim Key Achievements below 3 bullets.

## Hard Rules for All Agents

These are absolute — not suggestions:

1. **NEVER say "service mesh"** — Traefik v3 is ingress. Say "Traefik v3 ingress and cross-namespace routing with middleware chains."
2. **NEVER claim SLA compliance** — no formal SLA exists.
3. **NEVER claim on-call experience** — solo-operated, no on-call rotation.
4. **NEVER claim Terraform experience** — CDK only. Say "AWS CDK TypeScript (equivalent IaC capability)" if asked.
5. **NEVER say "enterprise-scale" or "100+ node clusters"** — dual-pool cluster, max 6 nodes.
6. **NEVER say "SLO-based error budgets" or "burn-rate alerts"** — threshold-based alerting only.
7. **NEVER claim EKS/GKE/AKS** — say "evaluated managed K8s, chose kubeadm for full-stack learning depth."
8. **NEVER claim fine-tuning or RLHF** — Bedrock API only, no model training.
9. **NEVER claim Commander.js CLI** — justfile task runner + TypeScript scripts.
10. **ALWAYS add scope qualifier in experience bullets** — "solo-operated" or "self-managed". BANNED in Professional Summary AND Skills section.
11. **NEVER claim "AWS Solutions Architect"** — the only AWS certification is \`AWS Certified DevOps Engineer – Professional\` (2025). Any other AWS credential is a fabrication.
12. Profile title field: must be a role descriptor, not a credential string. Never write a certification name as a job title.

## Concept Status Quick-Reference

| Concept | Status |
|---|---|
| Self-healing workloads (ArgoCD) | STRONG |
| Kubernetes internals (kubeadm) | STRONG |
| GitOps delivery (ArgoCD App-of-Apps, 25 apps) | STRONG |
| CI/CD pipeline design (22+ workflows) | STRONG |
| Three-pillar observability (Prometheus/Loki/Tempo) | STRONG |
| CDK multi-account IaC (4 accounts) | STRONG |
| AWS Bedrock / AI pipelines (4 applications) | STRONG |
| Service mesh | PARTIAL — use recommended_framing only |
| Formal SLOs / error budgets | PARTIAL — threshold-based alerting only |
| DORA metrics | PARTIAL — estimates, not measured dashboards |
| Multi-region active-active | ABSENT |
| Terraform / HCL | ABSENT |
| GCP / GKE | ABSENT |
| Fine-tuning / RLHF | ABSENT |


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

- **EKS / GKE / AKS** — deliberate choice to use kubeadm for learning depth
- **Terraform** — CDK only; can say "familiar with Terraform concepts, implemented IaC via CDK"
- **Helm chart authoring from scratch** — used existing charts; "configured and customised third-party Helm charts"
- **Service mesh (Istio, Linkerd)** — Traefik v3 provides L7 ingress. NEVER use "service mesh". Use "Traefik v3 ingress and cross-namespace routing" instead. No mTLS between pods.
- **Multi-region active-active** — single-region (eu-west-1) with edge stack in us-east-1 for CloudFront only
- **Fine-tuning / RLHF** — Bedrock API only; no model training
- **Formal SLOs** — threshold-based alerting; no error budgets or burn-rate alerts
- **Commander.js CLI** — justfile task runner + TypeScript. Do NOT claim Commander.js.
- **GCP / GKE / Google Cloud** — AWS-native portfolio; GCP status is IN_PROGRESS with no confirmed activity
- **Large-scale multi-node clusters** — dual-pool cluster (general t3.small 1–4, monitoring t3.medium 1–2)

**General evidence gate — applies to all IN_PROGRESS gap entries:**
| Evidence available | What agent may say |
|---|---|
| Confirmed activity in KB | Name only the specific confirmed activities |
| "Actively pursuing" with no confirmed activity | "I am actively beginning [technology] onboarding" |
| No evidence | Do not mention the technology in forward-looking context |

## What Was Built That's Unusual (Highlight These)

- Self-hosted Kubernetes without managed services — shows depth
- End-to-end observability from OS metrics to distributed traces to RUM
- Three distinct LLM system patterns — most engineers have zero production-pattern AI experience
- Reactive autonomous agent with real write access — not a toy chatbot
- 265+ IaC test assertions — most infrastructure code is untested


================================================================================
SOURCE: resume/voice-library.md
================================================================================

# Voice Library

Nelson's authentic writing voice. Retrieve before generating any resume bullet or cover letter paragraph. Anchor at least one phrase per paragraph.

## Authentic Phrases — Use as Anchors

### Action phrases
- "I took on the role of..."
- "I proactively covered [...] for fellow builders"
- "sharing my expertise to ensure..."
- "I chose to lean into learning as my primary response"
- "Recognising a knowledge gap, I proactively enrolled..."
- "taking responsibility for service continuity outcomes beyond my assigned workload"
- "enabling faster resolution for complex technical challenges"

### Outcome phrases
- "demonstrating my ownership mindset and commitment to team success beyond my core responsibilities"
- "enabling me to approach customer challenges with greater depth and confidence"
- "helping maintain consistent customer resolution timelines"

### Transition/positioning phrases
- "The transition was deliberate: [X] → [Y]"
- "built the platform AND deployed production workloads onto it" ← use without capitalised AND in final output
- "understanding how systems fail → building systems that recover automatically"

## Tone Profile

| Trait | Example | NOT this |
|---|---|---|
| **Action-first, not title-first** | "I took on the role..." | "In my role as X, I..." |
| **Specific over generic** | "official channels and one-to-one Slack" | "various communication methods" |
| **Outcome-linked effort** | "covered cases [...] maintaining customer resolution timelines" | "covered cases when needed" |
| **Honest about the journey** | "lean into learning as my primary response" | "consistently excelled in all areas" |
| **Direct first-person** | "I built X" | "X was built" / "responsible for building X" |
| **Specificity in numbers** | "10–20 hours per week" | "significant hours" |

## Sentence Length Variation (Anti-AI Pattern)

**Short punch:** "The result: zero dropped cases during the transition period."
**Medium evidence:** most bullets — technology + context + outcome
**Long context:** intro or positioning paragraphs

Rule: no more than 3 consecutive bullets of similar length.

## Banned Terms (AI Overuse)

| Banned | Use instead |
|---|---|
| spearheaded | led, drove, initiated, built |
| leveraged | used, applied, relied on |
| orchestrated | coordinated, ran, managed |
| revolutionized | changed, improved, replaced |
| streamlined | simplified, reduced, cut |
| robust | reliable, tested, production-ready |
| cutting-edge | (just name the technology) |
| results-driven | (omit) |
| dynamic professional | (omit) |
| passionate about | (omit) |
| demonstrated proficiency in | "built X" / "shipped X" / "ran X" |
| utilized | used |
| synergized | (never) |
| fostered | built, developed |
| stakeholders | name them: "customers", "engineers", "management" |

## Verbs Nelson Actually Uses

Portfolio context: built, configured, deployed, wrote, designed, ran, debugged, shipped, implemented, automated, tested, operated

Rule: start each bullet with one of these. No verb appears more than twice in any 6-bullet section.

## Anti-AI-Scan Checklist (AGENT-INTERNAL — never include in output)

Verify silently before finalising any section:
1. No consecutive bullets start with the same verb
2. No banned terms present
3. At least one bullet uses a short sentence (under 12 words)
4. At least one authentic phrase from this library is present
5. Specific proper nouns used — not generic descriptions
6. First-person in cover letter ("I built") not passive
7. Sentence lengths vary across the document
8. No phrase like "passionate about", "results-driven", "dynamic professional"


================================================================================
SOURCE: resume/role-archetypes.md
================================================================================

# Role Archetypes

Per-role emphasis maps. When given a job description, identify the archetype, pull bullets from achievements, apply concept-to-resume language, and respect gap-awareness. Adapt emphasis — never invent new claims.

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
1. Python/Bash automation system — case distribution, ROI analysis, business case, EMEA-to-global rollout
2. Operational playbooks and runbooks — structured processes adopted team-wide
3. Kubernetes operational depth — bootstrap automation (Step Functions + SSM + Python)
4. Root cause methodology — log correlation, distributed tracing, systematic diagnosis

**Exclude entirely:** Next.js, React, Tailwind, DynamoDB single-table design, HMAC token verification, Serverless REST API design
**Skills lead:** Scripting & Operational Tooling — Python first, then Bash, AWS CLI, kubectl
**Summary framing:** Lead with systematic troubleshooting and automation depth, not cloud architecture.

Example opener:
> "Infrastructure automation engineer with 3+ years diagnosing and resolving AWS production escalations, systematically debugging across IAM, compute, and networking layers and documenting findings as operational runbooks. AWS Certified DevOps Engineer – Professional. Built Python/Bash automation tooling eliminating 10–20 hours/week of manual workflow overhead."

**Gaps to acknowledge:** solo-operated, automation system pending security approval.

## Archetype 7: Technical Support / Customer Engineering

**Triggered when JD contains:** "support", "customer service", "SLA", "on-call", "escalations", "queue", "ticketing", "customer success", "technical account", "education on the use of our platforms"

This archetype takes priority over SRE and Operations when the role is customer-facing support or technical account work.

**Lead identity:** Support engineer who ships production systems — applies the same root-cause methodology to customer escalations as to internal incidents, backed by real Kubernetes and AWS production depth.

**Lead with (priority order):**
1. Customer-impact and reliability bullets — incident resolution, escalation handling, knowledge-base documentation
2. Kubernetes operational depth — demonstrates the production systems credibility behind customer-facing work
3. AI and automation proof — self-healing reactive agent, observability pipelines, prompt caching
4. Work history beneath the above — production depth validates the support framing

**sectionOrder:** summary, experience, projects, education, skills, certifications
(experience leads; projects surface production credibility before skills)

**Exclude entirely:** Detailed CDK assertions counts, Terraform references, frontend/React bullets, eCommerce metrics
**Skills lead:** Customer-facing: AWS troubleshooting, Kubernetes, distributed tracing, incident triage
**Summary framing:** Lead with customer-impact and reliability; close with a production-systems metric that demonstrates the engineering depth behind the support role.

Example opener:
> "Platform support engineer with 3+ years resolving AWS production escalations across IAM, compute, and networking — systematically debugging distributed systems, authoring operational runbooks adopted team-wide, and building self-healing Kubernetes automation. AWS Certified DevOps Engineer – Professional."

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
| "staff", "principal", "architect" | Mix archetypes equally — show breadth |

**Google-affiliated disambiguation:**
- "Server Operations", "Data Center Software", "Supply Chain", "operational tooling" → Archetype 6
- "SRE", "Production Engineer", "reliability" → Archetype 2
- "Software Engineer, Cloud AI", "LLM", "Gemini" → Archetype 4
- "Software Engineer, Full Stack" with React/TypeScript → Archetype 3
- "Technical Solutions Engineer", "Customer Engineer", "Support Engineer", "Technical Account Manager" → Archetype 7


================================================================================
SOURCE: resume/achievements.md
================================================================================

# Quantified Achievements

Canonical achievement statements grounded in implementation evidence. Preserve scope qualifiers — these are portfolio projects, not enterprise production systems.

## Engineering Discipline

| Achievement | Number | Scope |
|---|---|---|
| CDK infrastructure test assertions | **265+** assertions, 3,445 test lines | Portfolio project |
| Parameterised stack refactor | Eliminated **~600 lines** (3 stacks → 1) | Portfolio project |
| EC2 boot time | Reduced **75%** (12 min → 3 min) via Golden AMI | Portfolio project |
| IAM-only change deploy time | **~30 s** (vs. ~8 min full compute deploy) | Portfolio project |
| SSM Automation iteration saving | **~20 min saved** per bootstrap iteration | Portfolio project |
| Origin secret rotation downtime | **Zero seconds** (dual-valid regex window) | Portfolio project |
| GitOps self-heal window | Manual kubectl changes reverted within **3 min** | Portfolio project |
| SSM decoupling MTTR improvement | Stack failure MTTR from ~30 min → **~5 min** | Portfolio project |

## DORA Metrics (Estimates — not measured dashboards)

| Metric | Value | Notes |
|---|---|---|
| Lead Time for Changes | **~30 min** | Two-pipeline split timing |
| Time to Self-Recover | **~15 min** | Golden AMI + SSM Automation |
| Change Failure Rate | **~2%** | 8 test suites + integration gates |
| Deployment Frequency | **On-demand** (continuous) | ArgoCD Image Updater |

> DO NOT cite DORA numbers until confirmed measured values replace these estimates. Use qualitative outcomes in the interim.

## Infrastructure Scale

| Stat | Value |
|---|---|
| CDK stacks (Kubernetes domain) | **10** |
| ArgoCD-managed applications | **25** (use this number, not "20+") |
| AWS accounts managed via CDK | **4** (development, staging, production, management) |
| Bootstrap Python test suite | **55 tests**, fully offline |
| CDK infrastructure lines of code | **~8,500+** |
| CDK test lines of code | **~3,500+** |
| Test-to-code ratio | **1:0.47** |

## Observability Coverage

| Stat | Value |
|---|---|
| Grafana dashboards | **13** GitOps-managed |
| Prometheus scrape jobs | **12** |
| GitHub Actions workflows (monorepo) | **22+** |

## AI Engineering

| System | Key Number |
|---|---|
| Bedrock prompt cache hit rate | **~90% cost reduction** on Writer Lambda |
| Bedrock AI applications | **4** (article pipeline, job strategist, chatbot with RAG, self-healing agent) |
| LLM inference patterns implemented | **3** (Deterministic Workflow, Managed RAG, Reactive Autonomous) |

## Amazon Work History Accomplishments

| Achievement | Status |
|---|---|
| Service continuity lead — EMEA case coverage | STRONG |
| Technical Tooling SME — knowledge transfer | STRONG |
| Internal wiki documentation (3 years, multi-team) | STRONG |
| Case distribution automation — design + business case | IN_PROGRESS |
| AWS Certified DevOps Engineer – Professional (2025) | STRONG |
| Higher Diploma in Science in Computing (Web & Cloud Technologies) — Dublin Business School (2024) | STRONG |
| Year-end performance rating: Meets High Bar | STRONG |

## Resume Bullet Templates by Role

### Kubernetes / TSE / SRE / Container Operations
\`\`\`
Self-hosted Kubernetes cluster via kubeadm on AWS EC2 — bootstrapped control plane
from scratch, configured Calico CNI for pod networking with namespace-level
NetworkPolicies, ArgoCD App-of-Apps GitOps delivery (25 applications) with
self-healing and drift correction, Traefik v3 ingress with cross-namespace routing
and middleware chains, etcd and PKI backup to S3 with ~5–8 min control-plane RTO.
\`\`\`

### Platform / Infrastructure / IaC
\`\`\`
Designed 10-stack CDK architecture (VPC, security groups, compute, IAM, observability,
edge) with lifecycle-separated stacks — IAM-only changes deploy in ~30 s vs. ~8 min
full compute cycle.
\`\`\`

### SRE / Operations
\`\`\`
Built self-healing reactive agent (Bedrock ConverseCommand + 6 MCP tools) that
autonomously diagnoses CloudWatch alarms and triggers bootstrap Step Functions —
zero human intervention for transient node failures.

Designed disaster recovery path: etcd + PKI backup to S3, TLS/JWT to SSM, full
control-plane reconstruction in ~5–8 min RTO.
\`\`\`

### Full-Stack / TypeScript / System Design
\`\`\`
Designed and built a Yarn 4 TypeScript monorepo with two production-pattern
applications: Next.js 15 public site and TanStack Start admin dashboard.
System design decisions: Cognito PKCE auth flow, type-safe RPC via
createServerFn (12 server modules, zero API contract drift), full CSP headers,
OTel distributed traces, Prometheus metrics, Faro RUM, Vitest test coverage,
4-stage Docker builds, Blue/Green deployments via Argo Rollouts.
\`\`\`

### Operations Engineering / Internal Tooling
Lead bullet (IN_PROGRESS — use "currently implementing" or "designed" framing):
\`\`\`
Designed end-to-end Python/Bash automation system to replace 10–20 hours/week of
manual case distribution workflow in the EMEA support team — authored full ROI
analysis and business case for EMEA and global rollout; pending security review.
\`\`\`

Second bullet:
\`\`\`
Built and maintained internal knowledge base across multiple AWS teams over 3 years —
HTML/CSS/JavaScript structured documentation covering operational processes, runbooks,
and escalation paths; adopted team-wide as primary reference for new engineer onboarding.
\`\`\`

### AI / ML Engineering
\`\`\`
Designed and implemented three production-pattern LLM systems on AWS Bedrock:
Deterministic Workflow Agent (Step Functions + adaptive Extended Thinking),
Managed RAG Agent (Guardrails grounding 0.7 + defence-in-depth), and Reactive
Autonomous Agent (ConverseCommand tool-use loop with real write access to production
infrastructure via MCP Gateway).

Applied inference-time techniques including adaptive Extended Thinking (2K–16K token
budget), prompt caching (~90% cost reduction), and hybrid prompt design for
known vs. novel failure classes.
\`\`\`
`;
