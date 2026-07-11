---
id: constraints/agent-guide
version: 1
cachePoint: none
---
================================================================================
SOURCE: resume/agent-guide.md
================================================================================

# Agent Guide, Resume Generation

**Start here.** This is the direct path for AI agents generating resume summaries, achievement bullets, and cover letters from this knowledge base.

## Confidence Thresholds

| Status | What it means | What agents may say |
|---|---|---|
| **STRONG** | Fully implemented with file evidence | Claim directly and confidently |
| **PARTIAL** | Implemented with caveats or missing components | Use `recommended_framing` only, never full achievement_pattern |
| **IN_PROGRESS** | Exists but not production-validated | Use "currently implementing" language only |
| **ABSENT** | Not built | Never mention this concept |
| **IMPLIED** | Reasonable inference, not directly evidenced | Mention with hedging language only |

**Confidence score thresholds for archetype selection:**

| Signal strength | Score | Action |
|---|---|---|
| 3+ trigger phrases matched | 0.9+ | High confidence, proceed with archetype |
| 1–2 trigger phrases matched | 0.7–0.8 | Moderate confidence, proceed, flag if ambiguous |
| No clear trigger | 0.5 | Set `archetype_gap_detected = true`, use closest match, flag for human review |

## Resume Input Path Handling

**PATH A, No resume provided (default, recommended):**
Generate all content entirely from KB using archetype rules.
No structural constraints from any uploaded document.
This is the preferred path for all new applications, produces the cleanest output with no carry-over artefacts.

**PATH B, Resume provided (formatting reference only):**
The uploaded document is a FORMATTING REFERENCE. It contributes zero content.

Permitted uses:
- Section ordering preference
- Header and contact block format (name, email, location, links)

Prohibited uses (any violation is a fabrication error):
- Copying or paraphrasing any bullet, summary, or project description
- Using the uploaded skills list to select or exclude skills
- Treating any uploaded text as evidence of a claim

**Empty section rule (PATH B):**
If a section exists in the uploaded resume but has no KB evidence, leave that section EMPTY in the output, do not copy from the uploaded document to fill it.

**Archetype ordering rule (PATH B):**
If the uploaded resume structure conflicts with archetype section ordering requirements, the archetype ordering wins.

## Step-by-Step: Resume Summary

**Summary content filter, strict:**
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
| "staff", "principal", "architect" | Mix all three acts, show breadth |
| "troubleshoot", "customer", "solutions engineer", "escalation", "TSE", "technical support" | Customer-facing infrastructure narrative |
| "internal tools", "automated frameworks", "operational excellence", "playbooks", "data center", "server operations", "workflow execution", "supply chain software", "process standardisation" | Operations engineering narrative, lead with Python/Bash automation |

**Customer-facing support/TSE/Customer Engineering opener rule:**
The professional summary's FIRST sentence MUST echo the SELECTED ARCHETYPE's lead identity (the same positioning the headline + cover letter share) and lead with the candidate's strongest CAPABILITY / differentiator — NEVER a claimed job title. For a support / customer-engineering archetype, lead with the support-and-AI differentiator (e.g. "Builds production AI systems and applies the same root-cause methodology to customer escalations…"), NEVER an infrastructure-first identity ("Cloud infrastructure engineer…") and NEVER a title-first opener ("Support engineer with…"). Then the strongest number, then the AI/portfolio hook, then the cert. When a YEARS GAP FRAMING line is provided, the opener uses its (corrected) year count; never state a single-role tenure that undersells.
Rules: NEVER open with the certification name. Action-first, not title-first.

**kubeadm differentiator for TSE / Kubernetes roles, MUST articulate the WHY (as history, not present):**
> "Built the cluster with kubeadm first — control plane internals, etcd, kube-apiserver, kubelet, Calico CNI, the layer managed Kubernetes abstracts away and the layer that breaks in production customer escalations — then migrated it to managed EKS."

Always pair kubeadm with the EKS migration; never present kubeadm as the current platform.

**Use the managed service name from the JD, never hardcode one:**
| JD mentions | Managed service to name |
|---|---|
| "GKE", "Google Kubernetes Engine" | GKE |
| "EKS", "Amazon EKS" | EKS |
| "AKS", "Azure Kubernetes Service" | AKS |
| No specific service named | "managed Kubernetes services" |

## Step-by-Step: Achievement Bullets

1. Draw from the Achievements page below. Prioritise STRONG concepts.
2. For PARTIAL → use only recommended_framing. For IN_PROGRESS → "currently implementing". For ABSENT → do not generate.
3. Preserve all numbers, never round beyond what's in the achievements list.

**Every bullet describing a technical implementation MUST close with an outcome.**
Format: "[Strong verb] [specific technology + implementation detail], [concrete outcome]"

**LEAD BULLET rule, highest-impact first:**
Within each role, after archetype-category ordering is applied, the FIRST bullet MUST be the strongest number-led / highest-impact bullet, only bullets 1–2 are read, so the quantified win leads. Never bury a metric in bullet 3 or later when a stronger number exists earlier.

**Achievement bullet ordering rule, role-type driven:**

Infrastructure/support roles (TSE, SRE, Platform, Solutions, DevOps):
1. Kubernetes operational bullets first (kubeadm, Calico CNI, ArgoCD self-healing)
2. Customer-facing incident triage second
3. IaC and CI/CD third
4. Observability fourth, use Kubernetes-native implementation
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
1. Python/Bash automation bullets first, lead with this even if IN_PROGRESS
2. Operational runbooks and knowledge base documentation second
3. Kubernetes operational depth third
4. Root cause methodology fourth
5. Serverless, frontend, full-stack bullets EXCLUDED ENTIRELY
6. CDK bullets de-prioritised, supporting context only

Technical Support / Customer Engineering roles:
1. Customer-impact and reliability bullets first (escalation handling, knowledge-base documentation, resolution timelines)
2. Production systems proof second (Kubernetes operational depth, self-healing, distributed tracing)
3. AI and automation third, demonstrates engineering depth beyond ticket-closing
4. IaC and CI/CD fourth, supporting context
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
- ~90% prompt cache cost reduction (Writer Lambda only — the "Writer Lambda" scope qualifier is MANDATORY wherever this number appears; a section that bans qualifiers (summary, skills, projects) must OMIT the number entirely, never publish it unscoped)
- DORA metrics (lead time, TTSR, CFR): DO NOT use until real measured values exist. Omit entirely if no concrete value is confirmed.

## Step-by-Step: Key Projects

**PROJECTS COLLAPSE rule:**
When the selected archetype deprioritises standalone projects (support / customer-engineering archetypes, Archetype 7), DO NOT emit a standalone Projects block, instead emit ONE compact "Selected work:" line of curated, deduplicated GitHub links placed under the candidate's BUILDER/engineering role (e.g. Freelance, Cloud & DevOps), NEVER under a customer-facing / support / QA role — the GitHub work is engineering evidence. Builder/engineering archetypes (Platform, SRE, Full-Stack, AI/ML, DevOps) keep the full Projects block.

1. Maximum 2 projects per resume. Select the 2 most relevant to the JD.
2. Apply deduplication, each concept, tool, or number appears in full only once across the entire resume.
3. Never frame a project as "addressing a lack of X", frame as a deliberate architectural decision.

**Mandatory pre-flight deduplication check, AGENT-INTERNAL ONLY:**
Before drafting the second project, list every concept, tool, and number already used in Key Achievements. CI/CD pipeline detail is the most common failure point.

**Cross-section deduplication rule:**
| Already stated in | Rule for subsequent sections |
|---|---|
| Key Achievements | Projects gets one clause maximum for the same concept |
| Projects | Experience bullets reference it briefly or omit it |
| Summary | Achievements and Projects do not restate the same framing |

## Step-by-Step: Technical Skills

1. Order subsections to mirror JD priority, not alphabetically.
   (a) The FIRST skill group MUST be the archetype's matched-domain group, for a support/customer archetype, a "Support & Troubleshooting" group (escalation management, root-cause analysis, SaaS & cloud troubleshooting, SLA / resolution-time ownership) leads. (b) Within EVERY group, list JD-matched / required terms first; infra jargon last.
2. Each tool appears in one subsection only.
3. Scripting/tooling subsection mandatory for TSE, SRE, Support, Solutions Engineer roles.
4. "portfolio-scale" is BANNED in the Skills section. Never write it.

## Step-by-Step: Cover Letter

Output format: plain prose only. No markdown headings in the output.
1. Open with role identity variant (not cert-first).
2. Use one authentic phrase from Voice Library in the first paragraph.
3. Select 2–3 achievement bullets that map to JD top 3 requirements.
4. Close with the dual-perspective differentiator without capitalised AND.
5. Never close on a gap, close on the strongest claim restated in the language of the role.

**"portfolio-scale" / "solo-operated" ban in cover letters:**
Use "self-managed", "independently built and operated", or "built without a managed service abstraction" instead.

## Step-by-Step: Education

**EDUCATION ORDER rule:**
Order education entries by relevance-then-recency; do NOT give an older / less-relevant degree its own emphasis line; keep every degree name VERBATIM (never rename or abbreviate).

## ATS Optimization Rules

1. Exact keyword matching, use the JD's exact term.
2. Certification names verbatim: `AWS Certified DevOps Engineer – Professional` (en-dash).
3. Standard section headers: "Experience", "Skills", "Education", "Certifications".
4. Bullet format: [Strong verb] [specific technology/context] [measurable outcome].
5. No tables inside bullet lists.

## Human-Written Output Rules

1. Before generating any bullet, retrieve a phrase from the Voice Library and use it as an anchor.
2. Banned verbs: spearheaded, leveraged, orchestrated, revolutionized, streamlined, synergized, fostered, utilized.
3. Vary sentence length, mix short (under 12 words), medium, and long.
4. No consecutive same-verb openers.
5. Specific proper nouns over generic descriptions.
6. Cover letters: first-person direct, "I built X" not "X was built".
7. No opener clichés, never start with "I am writing to express my interest in".
8. Capitalised AND for emphasis (e.g. "built the platform AND deployed") is an AI-generation signal, banned.
9. Em dash (, ) permitted only in date ranges and role/company separators. All other uses banned.
10. Professional Summary opener, NEVER cert-first. First sentence MUST be a role identity statement.
11. Professional Summary: 100 words maximum. Closing sentence must contain one concrete DORA-flavoured number.

## Resume Word Count Budget, Hard Limits

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

These are absolute, not suggestions:

1. **NEVER say "service mesh"**, Traefik v3 is ingress. Say "Traefik v3 ingress and cross-namespace routing with middleware chains."
2. **NEVER claim SLA compliance**, no formal SLA exists.
3. **NEVER claim on-call experience**, solo-operated, no on-call rotation.
4. **NEVER claim Terraform experience**, CDK only. Say "AWS CDK TypeScript (equivalent IaC capability)" if asked.
5. **NEVER say "enterprise-scale" or "100+ node clusters"**, dual-pool cluster, max 6 nodes.
6. **NEVER say "SLO-based error budgets" or "burn-rate alerts"**, threshold-based alerting only.
6b. **NEVER claim or imply regulated COMPLIANCE (HIPAA / PCI DSS / NIST 800-53)** — describe the mechanism: policy-as-code gate with CDK-Nag RULE PACKS named as packs. "Enforcing HIPAA compliance" is banned; "CDK-Nag rule packs (HIPAA, NIST 800-53, PCI DSS) failing the pipeline on CRITICAL/HIGH" is correct.
6c. **FREELANCE = SOLO-BUILT PRODUCT**: present the independent role as "Solo-built production SaaS platform (Tucaken)" — whole-lifecycle ownership, never piecemeal contract framing.
7. **NEVER claim GKE/AKS** (never used). **EKS IS current and claimable** — the platform runs on managed EKS today (code stack authoritative: aws-eks, Karpenter, Pod Identity). kubeadm appears ONLY as the migration narrative ("built self-managed Kubernetes via kubeadm, migrated it to managed EKS"), never as the current platform. A Skills section naming Kubernetes MUST name EKS as current.
8. **NEVER claim fine-tuning or RLHF**, Bedrock API only, no model training.
9. **NEVER claim Commander.js CLI**, justfile task runner + TypeScript scripts.
10. **ALWAYS add scope qualifier in experience bullets**, "solo-operated" or "self-managed". BANNED in Professional Summary AND Skills section.
11. **NEVER claim "AWS Solutions Architect"**, the only AWS certification is `AWS Certified DevOps Engineer – Professional` (2025). Any other AWS credential is a fabrication.
12. Profile title field: must be a role descriptor, not a credential string. Never write a certification name as a job title.

## Concept Status Quick-Reference

| Concept | Status |
|---|---|
| Self-healing workloads (ArgoCD) | STRONG |
| Managed EKS (Pod Identity, Karpenter autoscaling) — CURRENT platform | STRONG |
| Kubernetes internals (kubeadm — historical: built, then migrated to EKS) | STRONG |
| GitOps delivery (ArgoCD App-of-Apps, 25 apps) | STRONG |
| CI/CD pipeline design (22+ workflows) | STRONG |
| Three-pillar observability (Prometheus/Loki/Tempo) | STRONG |
| CDK multi-account IaC (4 accounts) | STRONG |
| AWS Bedrock / AI pipelines (4 applications) | STRONG |
| Service mesh | PARTIAL, use recommended_framing only |
| Formal SLOs / error budgets | PARTIAL, threshold-based alerting only |
| DORA metrics | PARTIAL, estimates, not measured dashboards |
| Multi-region active-active | ABSENT |
| Terraform / HCL | ABSENT |
| GCP / GKE | ABSENT |
| Fine-tuning / RLHF | ABSENT |

