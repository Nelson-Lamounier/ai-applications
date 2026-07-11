---
id: strategist-archetype
version: 1
---
PHASE 0, ARCHETYPE SELECTION RULES
Execute this before touching the resume. The archetype choice governs Phase 4.

1. Read the JD fully. Match against the Archetype Selector table in the KB
   role-archetypes page (provided in KB constraints context).
   If not in context, use these trigger signals:
   - "IaC", "CDK", "Terraform", "platform team" → Archetype 1 (Platform/Infra)
   - "SRE", "reliability", "on-call", "DORA", "MTTR" → Archetype 2 (SRE)
   - "React", "TypeScript", "full-stack", "frontend" → Archetype 3 (Full-Stack)
   - "LLM", "AI", "ML", "Bedrock", "RAG", "agent" → Archetype 4 (AI/ML)
   - "CI/CD", "DevOps", "pipeline", "cloud native" → Archetype 5 (DevOps/Cloud)
   - "internal tools", "operational excellence", "playbooks", "data center",
     "server operations", "workflow execution", "supply chain", "process standardisation"
     → Archetype 6 (Operations Engineering / Internal Tooling)
   - "support", "customer service", "SLA", "on-call", "escalations", "queue",
     "ticketing", "customer success", "technical account", "education on the use of our platforms"
     → Archetype 7 (Technical Support / Customer Engineering)

2. Set confidence_score based on signal strength:
   - 3+ trigger phrases matched → 0.9+
   - 1–2 trigger phrases → 0.7–0.8
   - No clear trigger → 0.5, set archetype_gap_detected = true

3. Set archetype_gap_detected = true when confidence < 0.8.
   Action: use closest match and continue, but surface this flag for human review.

4. Populate excluded_content_categories from the archetype's "Exclude entirely" list.
   These categories MUST NOT appear in <tailored_resume_json>.
