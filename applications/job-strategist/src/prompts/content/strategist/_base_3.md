---
id: strategist-base-3
version: 3
---

════════════════════════════════════════════════════════════════════
              TAILORED RESUME JSON, GENERATION RULES
════════════════════════════════════════════════════════════════════

The <tailored_resume_json> is the AUTHORITATIVE resume output. No downstream
agent patches it. You produce the complete, production-ready StructuredResumeData.

GENERATION PROCESS (execute in this order):
1. Determine active path from the user message label:
   PATH A: generate from scratch using KB + archetype rules, no structural constraints.
   PATH B: use the formatting reference for section ordering and contact block ONLY;
           all bullets, skills, summary, and projects come exclusively from KB.
2. Apply Phase 0 archetype selection:
   - Remove content in excluded_content_categories from skills, summary, projects.
   - Reorder experience bullets so archetype-priority bullets appear first.
   - Update profile.title to a DESCRIPTIVE capability/domain headline derived from the
     archetype lead identity — take the DOMAIN/CAPABILITY descriptor and DROP any role-noun.
   - The profile.title MUST be a POSITIONING HEADLINE that is a DESCRIPTIVE capability/domain
     statement — e.g. "Cloud & AI Operations · Python Automation & Incident Response".
     It MUST NOT contain a job-title noun (Engineer, Associate, Analyst, Manager, Developer,
     Specialist, Lead, Architect, Consultant, Administrator, Technician…). NEVER claim a role
     the candidate does not hold; it must never conflict with the candidate's real employment titles.
3. Apply Phase 2 gap analysis:
   - For PARTIAL matches: use the framing_suggestion from Phase 2, not the full achievement.
   - For ABSENT concepts: do NOT include them, remove from skills and bullets.
   - For STRONG matches: include with full KB citation-backed evidence.
4. Apply audit trail changes (from <resume_tailoring>):
   - All <addition> bullets must appear in the JSON.
   - All <reframe> substitutions must be reflected in the JSON.
   - All <esl_corrections> must be applied globally.
5. Run safety checks (all mandatory, execute in this order, silently):

   a. PROHIBITED TERMS, scan every string field in the JSON:
      • "service mesh" → "Traefik v3 ingress and cross-namespace routing"
      • "SLA" / "SLA compliance" → "best-effort availability" or remove
      • "enterprise-scale" / "enterprise scale" → "dual-pool cluster" or remove
      • "Terraform" → "AWS CDK TypeScript"
      • "GKE" / "AKS" → REMOVE (never used). "EKS" IS claimable — the platform
        runs on managed EKS today (code stack is authoritative: aws-eks, Karpenter,
        Pod Identity). "kubeadm" appears ONLY inside the migration narrative
        ("built self-managed Kubernetes via kubeadm, migrated it to managed EKS"),
        never as the current platform. Skills sections listing Kubernetes MUST
        name EKS as current.
      • "fine-tuning" / "RLHF" → "Bedrock API integration"
      • "on-call" → "solo-operated" or remove
      • "Solutions Architect" or any AWS credential other than
        "AWS Certified DevOps Engineer – Professional" → REMOVE entirely
      • "portfolio scale" or "at portfolio scale" in summary → REMOVE phrase
      • "Commander.js CLI" → "justfile task runner"
      • NEVER claim or imply COMPLIANCE with HIPAA / PCI DSS / NIST 800-53 —
        running CDK-Nag rule packs is not being compliant, and an interviewer
        will probe PCI scope. Describe the MECHANISM: "policy-as-code gate
        (Checkov, 30 custom rules + CDK-Nag rule packs: HIPAA, NIST 800-53,
        PCI DSS) failing the pipeline on CRITICAL/HIGH misconfigurations".
        Frameworks may be named ONLY as rule packs, never as achieved
        compliance ("enforcing HIPAA compliance" is banned).
      (Note: these rules are intentionally mirrored from agent-guide.md §Hard Rules.)

   b. ANTI-AI-PATTERN CHECK, scan every bullet and paragraph:
      • "Leveraged X to achieve Y" → "Used X to deliver Y"
      • "Spearheaded the implementation of" → "Built" or "Designed and deployed"
      • "Orchestrated" → "configured", "deployed", or "ran"
      • "Revolutionised" → "rebuilt", "replaced", or "redesigned"
      • "Streamlined", "synergized", "fostered", "utilized" → rewrite with direct verb
      • Abstract rigor claims ("systematic depth", "engineering excellence",
        "technical depth") → DELETE; the concrete gating/testing details
        already carry rigor — the abstraction sounds good and means little
      • Capitalised AND for emphasis (e.g. "built AND deployed") → restructure
      • Em dash (, ) as mid-sentence connector → restructure with comma or full stop
        Em dash permitted only in date ranges and role/company separators
      • Metrics with "~", "estimated", "approximately", "est." → REMOVE metric entirely
        A hedged number is worse than no number, signals unmeasured systems
      • Three or more consecutive bullets starting with the same verb → vary openings
      (Note: mirrored from agent-guide.md §Human-Written Output Rules.)

   c. WORD COUNT, count every section before returning. The rendered PDF must
      fit TWO A4 pages — 880 words total is that ceiling — and must also FILL
      them: TARGET 700-880 words. A resume under ~700 words leaves the second
      page half-empty and triggers a machine expansion pass you do not
      control; fill the space yourself with GROUNDED, JD-relevant evidence
      (more bullets on the primary role, fuller project beats) — never with
      padding or repetition. A deterministic enforcement pass measures the
      output and trims anything over budget. Hard maximums:
      • summary: leave as "" here — a dedicated summary pass composes it
        (see the summary directive in the output contract above).
      - experience: roster skeleton only -- word budget enforced by the experience pass
