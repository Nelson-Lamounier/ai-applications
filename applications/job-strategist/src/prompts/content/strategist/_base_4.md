---
id: strategist-base-4
version: 2
---
      • keyAchievements: DO NOT EMIT (always an empty array) — achievement
        material integrates into experience lead bullets and the summary metric
      • Grand total across all sections: 950 words max
      SELECTION RULE (before trimming): every piece of content must answer a
      JD required skill, a responsibility, or the company problem. One strong
      proof per requirement beats three restatements — never saturate.
      TRIM ORDER when over budget (apply in sequence until under limit):
        1. Remove any skill not in the JD's top 5 requirements
        2. Drop the least JD-relevant project highlight (never below 2 per project)
        Do NOT return a resume that exceeds 950 words total.
      (Note: mirrored from agent-guide.md §Resume Word Count Budget.)

   d. SCOPE QUALIFIER RULE:
      • BANNED in summary, skills, projects: never write "portfolio-scale",
        "portfolio scale", "solo-operated", or "self-managed" in those sections.
        Technical specifics (EKS + Karpenter, Calico CNI, 265+ assertions) carry
        the scope signal in those sections. Explicit qualifiers undersell.
      • SCOPED EVIDENCE CARRIES ITS SCOPE: when KB evidence attaches a scope
        qualifier to a metric (e.g. "prompt cache cost reduction — Writer Lambda
        only"), any claim using that metric MUST include the qualifier verbatim-
        adjacent (e.g. "on the Writer Lambda"). If the target section bans
        qualifiers (summary, skills, projects), OMIT the metric there entirely —
        never publish the unscoped number.
      (Note: mirrored from agent-guide.md §Hard Rules rule 10.)

   e. CROSS-SECTION DEDUPLICATION:
      Each concept, tool, or metric may appear in full only ONCE across the resume.
      Every subsequent mention must add new signal (deeper detail, different context,
      specific outcome) or be removed entirely.
      • projects → experience references it briefly or omits it
      • summary → experience and projects do not restate the same framing
      • skills → experience bullets do not list the same tools again
      Common duplications to catch:
        ArgoCD in both K8s and CI/CD subsections → keep in the most JD-relevant
        Prometheus in both Observability and K8s → keep in Observability
        Calico CNI in both K8s and Security → keep in K8s; mention policy in Security
        GitHub Actions workflow count (22+) and CDK assertions (265+) → use once
      (Note: mirrored from agent-guide.md §Cross-section deduplication rule.)

