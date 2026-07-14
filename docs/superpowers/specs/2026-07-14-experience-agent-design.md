# Phase 4 -- Dedicated Experience Agent -- Design

**Date:** 2026-07-14
**Status:** Approved design -- pending implementation plan
**Reference implementation:** the Phase 3 summary lane (PR #483): `agents/writer/summary-agent.ts`, `summary-ats-flow.ts`, `ats/gate/summary-ats-targets.ts` + `summary-coverage.ts`, `evals/summary/`.

## Problem

The strategist-writer authors experience bullets while structurally blind to the
material that matters:

1. `formatExperienceFacts` strips career highlights to `title -- company (period)`
   (`agents/evidence/career-history.ts:55-66`), so the writer never sees the
   user's actual experience lines. It synthesises bullets from skill evidence
   instead of REWRITING the user's own lines -- output reads as a copied list,
   not a JD-tailored profile.
2. `checkExperienceFidelity` then demands >=2-token overlap with exactly those
   unseen highlights (`agents/quality/guards/fidelity-rules.ts:24-43`).
3. The grounded-metrics ledger is withheld from the writer and Haiku-woven in
   afterwards (`run-pipeline.ts:1041-1046`, `weaveGroundedMetrics`).
4. Up to five post-writer LLM passes patch the result (guard rewrite, migration
   reframe, condense, metric weave, surfaceKeywords XYZ restructure).

Observed symptom (live): a JD hard requirement "Networking concepts and
protocols (DNS, TCP/IP, SSL/TLS)" was never woven into the employer bullets even
though the career history honestly supports it.

## Goals

1. A dedicated Experience agent that REWRITES and REORDERS the user's own career
   lines against the JD -- profile voice, not a task list -- with zero
   fabrication.
2. ATS-aware by construction AND measured: full Summary-mirror lane (targets ->
   score -> one bounded re-write -> keep the better guard-passing candidate).
3. Schema-enforced provenance: fidelity checkable by citation, not token overlap.
4. Phase-3-grade observability + isolated cost + evals before scale.

## Non-goals

- Free tier (free-resume-writer untouched).
- Projects/skills/education sections (unchanged writer ownership).
- Retiring the downstream safety net in this phase (only the metric weave is
  retired for experience; the rest stays, with firing counters).
- DB migrations (none needed).

## Decisions (locked with the user)

1. **Full decouple, Summary pattern:** the writer emits experience as a ROSTER
   SKELETON -- `{company, title, period, highlights: []}` verbatim from career
   facts. The Experience agent authors all bullets. One author per section.
2. **Agent owns numbers:** the grounded-metrics ledger moves INTO the agent
   payload; `weaveGroundedMetrics`/`surfaceMetrics` is retired for experience.
   The remaining net (fidelity guard, condense/hard-trim, stripUngroundedNumbers,
   surfaceKeywords) stays, each firing counted in Loki so later retirement is
   evidence-based.
3. **Full ATS mirror:** score the generated section's target coverage; if any
   target is missing, ONE bounded re-write under a distinct agent name
   (`strategist-experience-rewrite`); keep the better guard-passing candidate;
   tie/no-gain/guard-fail/throw -> keep first.
4. **Schema-enforced provenance** (anti-copy-paste + anti-hallucination): every
   output bullet cites the career line(s) it was rewritten from; every career
   line is accounted for (used, merged, or dropped with a reason); the system
   validates this deterministically and assembles the final strings.

## Architecture & data flow

```text
writer (persona v-bump): experience = roster skeleton, highlights: []
  |
fillResumeExperience (new splice in run-pipeline, runs BEFORE fillResumeSummary
                      so the summary agent composes against the real body)
  executeExperienceAgent (Sonnet, forced `emit_experience` tool, thinkingBudget 0,
                          ONE call covering all roles)
  -> deterministic provenance validation (reject = treat as agent failure)
  -> scoreSummaryCoverage(joined experience text, targets)   [REUSED -- already (text, targets)]
  -> covered < targets.length  ->  ONE re-write (agent name strategist-experience-rewrite,
       message carries the draft + missing targets)
  -> keep better provenance-valid candidate (decideKeep pattern from summary-ats-flow)
  -> splice into tailoredResumeData.experience
  |
existing downstream chain UNCHANGED as safety net (reconcileRosterAgainstCareer,
guardResume/fidelity, condense/hardTrim, stripUngroundedNumbers, surfaceKeywords)
metric weave: retired for experience
```

Fallback: agent call error OR provenance-invalid first pass -> the career
highlights VERBATIM (truthful, never empty) -- the deterministic equivalent of
`deterministicSummary`. A re-write error/invalid keeps the first pass; it never
triggers the verbatim fallback.

## Components

### experience-message.ts (new, `agents/writer/`)

Builds the agent's user message. Sections:

- `## Career History (line-by-line, indexed)` -- every role, every highlight as
  an indexed source line (`[c0.h1] ...`). Instruction block: every line MUST be
  accounted for -- rewritten (JD vocabulary where honestly applicable), merged,
  reordered, or consciously dropped with a reason; never copied verbatim when
  tailoring honestly applies; never synthesised from nothing.
- `## JD Requirements + ATS Targets` -- attainable targets per JD requirement
  (verified/transferable only, from the skill-evidence ledger; gaps excluded),
  e.g. `Networking concepts and protocols -> DNS, TCP/IP, SSL/TLS`. Weave each
  where a source line honestly supports it; omit otherwise.
- `## Grounded Metrics` -- the ledger (allowed numbers), previously withheld.
- `## Verified / Partial Matches` (with sourceCitation), `## Code Stack
  (currency rule)`, `## Role Emphasis` -- trimmed to what experience needs.
- Re-write pass fields (optional, mirror summary-message): `rewriteDraft`,
  `rewriteMissing`.

### experience-agent.ts (new, `agents/writer/`)

`executeExperienceAgent(ctx, input, opts?: {agentName?})` -- Sonnet, forced
`emit_experience` tool, `thinkingBudget 0` (constrained decoding), prompt module
`content/strategist/experience-agent.md` (new; own version + manifest entry).
Persona: profile voice -- each role tells ONE arc (lead bullet = that role's
thesis against the JD), JD-relevance ordering, composition rules preserved from
today's `experience.md` (32-word bullets, verb-first, one number per bullet,
impact clause, 3-5 bullets/role, scope qualifiers).

Tool output schema (the per-phase tight schema):

```text
{ roles: [{ company, title, period,
            highlights: [{ text, sources: string[],      // e.g. ["c0.h1","c0.h3"] or metric ids
                           atsTargets: string[] }] }],
  accounting: { dropped: [{ line: string, reason: string }] } }
```

### experience-provenance.ts (new, `agents/writer/`)

Deterministic validator (pure): (a) every bullet cites >=1 source line belonging
to THAT employer (metric ids allowed as secondary sources only); (b) every input
career line appears in some bullet's `sources` or in `accounting.dropped`;
(c) `company/title/period` byte-identical to the roster skeleton; (d) bullet
count 2-5 per role. Violation list returned; any violation = candidate invalid.
The SYSTEM assembles `highlights: string[]` from valid output (model never
controls the final assembly).

### experience-ats-flow.ts (new, `agents/writer/`)

Mirror of `resolveSummaryAts`, parameterised for experience: fire the re-write
when `covered < targets.length` (close every honest gap once); guard =
provenance validity (+ `namesGap` per bullet); keep rule identical to
`decideKeep` (prefer provenance-valid; then higher covered; tie/no-gain/fail ->
first). Coverage scored with the REUSED `scoreSummaryCoverage` (strict
adjacent-phrase -- the locked Phase 3 predicate) over the joined bullet text.
Targets from a `selectExperienceAtsTargets` wrapper over the same ledger + JD
must-haves machinery as `selectSummaryAtsTargets`, with a higher limit (top 6)
and per-requirement grouping so a composite requirement ("Networking concepts
and protocols (DNS, TCP/IP, SSL/TLS)") contributes its attainable members.

### run-pipeline changes

- Writer persona modules (`experience.md`, `_base_1/3/4`) rewritten: emit roster
  skeleton only; bullet-authoring rules move to the new agent persona. Version
  bumps + manifest hashes for every edited module.
- New `fillResumeExperience(...)` splice after the writer, BEFORE
  `fillResumeSummary`. Returns `ExperienceAgentDiagnostics` for observability.
- `weaveGroundedMetrics` no longer touches experience. Rule: if `surfaceMetrics`
  mutates ONLY experience bullets, retire the whole step; if it also touches
  other sections, scope it to skip `experience` and leave the rest unchanged.
- Safety-net firing counters: when fidelity-guard rewrite, surfaceKeywords, or
  condense fire ON EXPERIENCE after the agent, increment a labelled counter --
  the evidence base for later retirement.

### AgentName union

Add `strategist-experience` and `strategist-experience-rewrite`
(`shared/src/types.ts`) for isolated cost in `prompt_invocations`.

### Observability (Phase 3 mirror)

- Loki events: `experience_agent_targets` / `_scored` / `_rewrite` /
  `_provenance_reject` / `_fallback` + safety-net firing events -- keyed
  `pipeline_run_id` / `application_id` (traceId null in run-pipeline).
- Durable: `pipeline_runs.metadata.analysis.experienceAgent` (targets, coverage
  before/after, rewrite decision, provenance stats incl. dropped lines + reasons,
  fallback) -- folded into the EXISTING analysis metadata write (shallow-merge
  constraint).
- Prometheus: `job_strategist_experience_agent_outcome_total{outcome,reason}`
  (bounded reasons -- raw errors Loki-only) + coverage histogram + a
  `job_strategist_experience_net_fired_total{pass}` counter for the safety net.
- Cost: the two agent names booked separately; queryable per application via
  `prompt_invocations` (`agent LIKE 'strategist-experience%'`).

## Testing / evals (before scale -- CLAUDE.md section 5)

- Unit: provenance validator (all four rules + assembly), ats-flow decision
  table (fire/no-fire/throw/provenance-preference/no-targets), message builder
  (indexed lines, targets section, re-write block), targets wrapper (gap
  exclusion, composite-requirement grouping).
- `evals/experience` graders (pure, reuse runtime predicates): provenance
  (every bullet cites in-role sources), no-fabrication (numbers subset of the
  ledger plus source lines), ATS coverage (targets surfaced when honestly supported --
  golden fixture built from the networking example), voice (32-word/verb-first/
  one-number rules), reorder (most JD-relevant bullet leads each role).
- Golden fixture: a career history containing real networking lines + a JD with
  the composite networking requirement; the golden output weaves
  `DNS/TCP-IP/SSL-TLS` into the supported role with correct citations.
- Live validation owed post-deploy: UI JD A/B on a real run; check
  `experienceAgent` metadata + safety-net counters (expect surfaceKeywords
  firing on experience to drop toward zero).

## Consequences

- Up to two large Sonnet experience calls on low-coverage runs (user-accepted).
- Writer prompt shrinks; experience quality is solely the new agent's
  accountability; numbers have ONE owner.
- The copy-paste symptom is addressed mechanically: the agent cannot emit a
  bullet without citing which user line it rewrote, and cannot silently ignore
  lines (accounting), while the JD/ATS section tells it exactly which vocabulary
  to weave where honestly supported.
