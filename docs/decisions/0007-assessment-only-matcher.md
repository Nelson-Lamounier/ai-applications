---
title: Assessment-only matcher over free-form matching
type: decision
tags: [job-strategist, matcher, jd, deterministic, structured-output, architecture]
sources:
  - applications/job-strategist/src/agents/research-assessment.ts
  - applications/job-strategist/src/agents/research-agent.ts
  - applications/job-strategist/src/ats/canonical-jd-skills.ts
created: 2026-06-16
updated: 2026-06-16
---

## Status

Accepted — implemented as-deployed (PRs #231 canonical list, #232 assessment-only
matcher + ledger collapse). The matcher emits one verdict per canonical JD skill;
`assessmentsToMatching()` derives the legacy buckets
([research-assessment.ts:84](../../applications/job-strategist/src/agents/research-assessment.ts#L84)).

## Context

The matcher (research agent) used to invent its own three free-form skill lists —
`verifiedMatches`, `partialMatches`, `gaps` — by re-reading the job description
independently of the `jd-extractor`. This produced **two skill universes**: the
JD-extractor's canonical list (e.g. 18 skills) and the matcher's self-invented
set (e.g. 11). They diverged because each LLM read of the same JD returns
different output. The downstream skill-evidence ledger and the strategist could
not reconcile against a moving target, and gaps could be silently masked when the
matcher's wording differed from the canonical list.

See [jd-read-centralisation](../concepts/jd-read-centralisation.md) for the wider
single-read refactor this decision is part of.

## Decision

The matcher is **assessment-only**. It is given the canonical JD skill list
([canonical-jd-skills.ts:42](../../applications/job-strategist/src/ats/canonical-jd-skills.ts#L42))
and emits exactly **one verdict per skill** — a `SkillAssessment` with
`verdict: 'verified' | 'partial' | 'gap'` and the fields that verdict requires
([research-assessment.ts:17-36](../../applications/job-strategist/src/agents/research-assessment.ts#L17-L36)).

`assessmentsToMatching()` routes each verdict back into the legacy
`verifiedMatches / partialMatches / gaps` shape, so every downstream consumer (the
years/vendor/code guards, the skill-evidence ledger, the strategist) is unchanged.
A skill the model failed to assess defaults to a **soft gap** — honest: never
claim evidence the matcher did not assert
([research-assessment.ts:3-13](../../applications/job-strategist/src/agents/research-assessment.ts#L3-L13)).

## Consequences

**Enabled:**

- **Reconciliation by construction.** The matcher's verdict universe *is* the
  canonical list, so the donut "Skill coverage" and the ledger "Evidence
  coverage" align — the 18-vs-11 divergence is gone.
- **Coverage guarantee.** Every canonical JD skill lands in exactly one bucket;
  nothing assessed is lost and nothing unassessed is silently dropped.
- **Honest gaps.** Unassessed → soft gap; the ledger then resolves gaps with
  precedence over transferable foundations (see
  [skill-evidence-ledger](../concepts/skill-evidence-ledger.md)).

**Prevented:**

- Two independent JD reads drifting apart per LLM call.
- The matcher inventing skills the JD read never named.

**New problems / accepted residual:**

- The matcher can no longer surface a skill outside the canonical list. That is a
  deliberate constraint — the canonical list is the single source of truth; if a
  skill matters, it must come from the JD read, not the matcher.
- A forced one-verdict-per-skill schema is stricter on the model; mitigated by
  forced tool-use + a Zod safety net and a per-phase eval (`coverage` /
  `verdictAccuracy` graders).

## Alternatives considered

### Keep free-form matching (the prior behaviour)

Rejected. Letting the matcher invent its own lists is what created the two-universe
divergence and the masked-gap class of bugs.

### Union of JD-tools ∪ matcher-skills

An interim step (PR #230) that unioned both skill sets in the ledger to stop
drops. Rejected as the end state: it papered over the divergence rather than
removing it. Once the matcher became assessment-only the union collapsed to a
single pass over the canonical list.

<!--
Evidence trail (auto-generated):
- Source: applications/job-strategist/src/agents/research-assessment.ts (read on 2026-06-16, lines 1-90)
- Source: applications/job-strategist/src/ats/canonical-jd-skills.ts (read on 2026-06-16, line 42)
- Commit: efe6733 (#232 JD-read centralisation — matcher assessment-only); c6bf5bf (#231 canonical JD skill list)
-->
