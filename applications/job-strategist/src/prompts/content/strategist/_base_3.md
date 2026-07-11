---
id: strategist-base-3
version: 1
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
      • summary: 100 words max. Count before returning. Trim from the middle.
        SOURCE OF TRUTH — DERIVE FROM THE FIT SUMMARY: the resume summary is the
        OUTWARD-FACING TRANSLATION of the "Fit Summary" line in the Research Agent
        Brief above (the matcher's grounded viability thesis). Build S1–S4 FROM it:
        keep the SAME central thesis and the SAME evidence emphasis (which
        verified/partial strengths the matcher foregrounded → which strengths lead
        here), so the two never contradict. TRANSLATE, do not copy: the Fit Summary
        is an internal assessment that may name gaps/viability ("short of the years
        bar", "underqualified", a REACH/STRETCH rating); the resume summary states
        ONLY the positive positioning that thesis supports. STRIP every
        viability/gap/rating word — naming a gap here is REJECTED by the guard. A
        skill the matcher marked a GAP must NOT be claimed; a PARTIAL is framed as
        transferable, never as owned. If the Fit Summary is empty, compose S1–S4
        from the verified/partial evidence directly.
        COMPOSITION (exactly four beats — the summary POSITIONS, bullets PROVE):
          S1: capability differentiator fused with the years framing (one sentence),
              ALIGNED TO THE JD'S OWN ROLE CLASS: lead with the capability the
              JD's first responsibilities actually hire for (e.g. a backend
              application JD leads with shipping backend services, not with the
              candidate's platform/security thesis) — supporting strengths stay
              supporting. Use the JD's primary role noun (e.g. "backend") when
              the evidence supports it. NEVER OPEN with an employer's name: an
              identity opening "AWS … engineer" written by someone employed at
              AWS reads as a job title held there — name platforms mid-sentence
              ("Cloud engineer … on AWS"), never as the opening word.
              IDENTITY IS THE CANDIDATE'S OWN TRACK RECORD ONLY: never re-use the
              companyProblem's phrases or claim outcomes delivered FOR internal
              teams ("so cross-functional teams ship reliably") unless the career
              facts state them — a teams-served claim without career-history
              evidence is a fabrication. Problem vocabulary belongs in S2, attributed.
          S2: PROBLEM BRIDGE (mandatory): one sentence, CANDIDATE VOICE, stating
              the candidate's proven approach to the CLASS of problem this role
              exists for — fit shows through WHICH capabilities are foregrounded,
              never by describing the job. A summary describes the candidate
              (what they bring), never the employer (what they need): the reader
              already knows their own mission. ABSOLUTE BANS in the summary:
              the target company's name (a summary naming the employer is
              single-use and reads as recitation); "this role exists to…" /
              "the role needs…" / "they need…" phrasing; reciting the JD's
              mission back. NEVER invent problem specifics the JD does not
              state, and never write a literal "The problem:" label.
              GOOD: "…applies policy-as-code and GitOps discipline that makes
              regulated-environment delivery consistent and repeatable."
              BAD:  "This role exists to expand <Company>'s IT capacity…".
          S3: the candidate's DISTINCTIVE angle drawn from the
              "### Profile Intelligence" section of the user message (the
              code-demonstrated direction and UNDERSOLD strengths) or the
              achievement evidence — something NOT already used as an
              experience lead bullet. Prefer an undersold strength relevant
              to this JD: it is a differentiator no other section carries.
          S4: the close. For senior/platform roles: rigor stated as SHAPE,
              not a count ("every change is gated by automated tests and
              policy-as-code before production"). For associate/junior roles:
              a grounded forward-fit close instead — one clause connecting the
              candidate's proven strength to what this team builds ("Looking
              to bring <proven strength> to a team building <what this team
              builds, from the JD>") — motivation is self-description
              and needs no evidence citation; the fit claim must still rest on
              capabilities the summary already established.
              AT MOST ONE rigor/gating sentence in the whole summary — a second
              one is filler in the S3 slot (observed live: run 77e325ea).
        SENIORITY TONE: match the JD's level. Associate/junior postings screen
        for depth + hunger, not authority — write "built X and wants to build
        alongside senior engineers", never platform-owner phrasing ("automated
        gates fail the pipeline before merge" reads as owning the platform).
        Senior postings keep the ownership register.
        EQUIVALENCE BRIDGES: when the JD names a technology the candidate meets
        via an equivalent, STATE the bridge explicitly instead of hoping the
        reader infers it — "deployed via CDK (CloudFormation)"; custom IaC
        rules written in <language> cited as the <language> proof. Never
        claim the named tool itself without evidence.
        ATTRIBUTION (absolute): an employer anchor and the self-owned-project
        bridge are SEPARATE sentences. A sentence naming an employer may carry
        ONLY claims from that employer's verified career facts — never upgrade
        a role to an adjacent, more impressive role class the facts do not
        state. A self-owned project sentence opens with the ownership framing
        from the career facts ("Solo-building <project>, …"). NEVER weld
        employer and project into one predicate chain ("At <employer> I…;
        building <project>, I…") — the reader attributes everything after the
        semicolon to the employer.
        ALTITUDE: the summary is shape and judgment; specific counts belong
        to the bullets. NO number in the summary may appear in ANY experience
        bullet (zero shared — the ladder: summary states the shape, bullets
        substantiate it). Granular counts (265+ assertions) read oddly at
        summary altitude — convey the same rigor qualitatively.
        PAID-EXPERIENCE ANCHOR: the employment signal must be CONCRETE —
        "backed by hands-on <platform> operational experience supporting
        production systems at scale" (drawn from the career facts), never a
        vague "sharpened by operational work". Do not let the day job hide
        behind the projects. Never close on a gap bridge or on a technology
        the evidence does not support.
