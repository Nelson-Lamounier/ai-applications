# JD Agent Consolidation — design

**Date:** 2026-06-12
**Status:** Approved (design) — pending plan
**Repo:** `ai-applications` (`feat/jd-agent-consolidation`, off `develop`)
**Supersedes Part A of:** `2026-06-12-ats-feedback-loop-design.md` (the ATS feedback loop, #3, builds on this)

## Problem (proven on run `a52c96fe`)

Two Haiku passes extract the **same** JD facts:
- `jd-extractor` → `requiredSkills, tools, concepts, retrievalKeywords` (drives KB queries + ATS grading)
- `research agent` → `hardRequirements, technologyInventory, experienceSignals` (drives the writer + the "What we understood" UI)

The overlap is near-total (`technologyInventory.tools` ≡ jd-extractor `tools`, etc.), and they're **misaligned** — the writer targets one list, the ATS grades against the other.

## Goal

**One JD agent owns all JD understanding.** The research agent becomes a **KB-matching agent** — it receives the JD signal and produces only the candidate↔JD match. No JD re-extraction.

## The split (grounded in `StrategistResearchResult`)

| The **JD agent** produces (JD understanding) | The **research agent** keeps (matching) |
|---|---|
| `targetRole, seniority, domain` | `verifiedMatches, partialMatches, gaps` |
| `hardRequirements, softRequirements, implicitRequirements` | `overallFitRating, fitSummary, pillarClassification` |
| `technologyInventory, experienceSignals` | `resumeData` (parsed candidate resume) |
| `retrievalKeywords` (KB queries) + atomic ATS keyword list | `kbContext, kbRetrievalStats` (retrieval evidence) |

## Architecture

### 1. JD agent (`jd-extractor.ts` → the JD agent)
Extend the existing forced-tool Haiku extractor to emit the full JD signal:
- Keep: `requiredSkills, preferredSkills, tools, concepts, responsibilities, domain, seniority, retrievalKeywords`.
- Add: `targetRole`, `hardRequirements: JobRequirement[]` (with `disqualifying` + `context`), `softRequirements: JobRequirement[]`, `implicitRequirements: string[]`, `technologyInventory: TechnologyInventory`, `experienceSignals: ExperienceSignals` (incl. `yearsExpected`).
- The atomic ATS keyword list = `collectJdMustHaves(jdSignal)` from `technologyInventory` (tools+languages+methodologies) — the SAME list the writer targets (replaces `collectJdMustHavesV2(jdExtraction)`).
- Output type: `JdSignal` (new, in shared) — a superset of today's `ExtractedJobData` covering all JD-derived `StrategistResearchResult` fields.

### 2. Research agent (matcher)
- Input gains the `JdSignal` (no longer derives requirements from raw JD).
- Tool/output schema **drops** the JD-signal fields; keeps `verifiedMatches, partialMatches, gaps, overallFitRating, fitSummary, pillarClassification, resumeData, kbContext`.
- Persona rewritten: "You are GIVEN the JD requirements. Match the candidate's KB + career evidence against them — verified / partial / gap — and rate fit. Do NOT re-derive the JD."
- KB retrieval is unchanged mechanically (still `jdRetrievalQueries(jdSignal)`), now sourced from the JD agent's keywords.

### 3. run-pipeline (assembly)
- `const jd = await extractJdSignal(ctx.jobDescription)` (the JD agent, fail-open with a minimal fallback).
- `const matching = await executeResearchAgent(ctx, pool, …, jd, …)` — returns only the matching half.
- `const research = { ...jd, ...matching }` → the existing `StrategistResearchResult` shape, unchanged for the **strategist** (zero change downstream of assembly).
- The ATS grades against `collectJdMustHaves(jd)`; the recruiter-snapshot reads `jd.hardRequirements`; the UI "What we understood" reads the `jd.*` fields.

### `StrategistResearchResult` stays the same shape
The strategist, persistence, admin-api, and UI are **unchanged** — they still consume one merged `research` object. Only WHO produces each half changes. This bounds the blast radius: the refactor is isolated to the two agents + the assembly point.

## Honesty / quality

- Matching quality should hold or improve: the matcher gets a clean, structured JD signal instead of re-parsing boilerplate.
- `verifiedMatches` still come only from KB/career evidence (unchanged).
- One fewer LLM pass over the JD's requirement structure (the JD agent does it once); the research agent's call is now focused on matching.

## File list

- `applications/shared/src/strategist-types.ts` — `JdSignal` type (the JD agent's output); `StrategistResearchResult` documented as `JdSignal & ResearchMatching`.
- `applications/job-strategist/src/agents/jd-extractor.ts` — extend to the JD agent (schema + tool + prompt); export `extractJdSignal`.
- `applications/job-strategist/src/prompts/jd-extractor-persona.ts` (or inline) — JD-understanding prompt.
- `applications/job-strategist/src/agents/research-agent.ts` — drop JD-signal extraction; accept `JdSignal`; matcher-only schema + persona.
- `applications/job-strategist/src/prompts/research-persona.ts` — rewrite to matcher.
- `applications/job-strategist/src/ats/jd-keywords.ts` — `collectJdMustHaves(jdSignal)` replaces the V2 jd-extractor source.
- `applications/job-strategist/src/run-pipeline.ts` — JD agent → research(matcher) → assemble → strategist; ATS/snapshot/metadata read `jd.*`.
- Tests for each agent + the assembly.

## Testing

- JD agent: a JD → full `JdSignal` (requirements with disqualifying, techInventory, experienceSignals, keywords). Fail-open → minimal fallback.
- Research matcher: given a `JdSignal` + KB evidence → verified/partial/gaps/fit; does NOT emit requirements; fail-open.
- run-pipeline: `research = {...jd, ...matching}` equals the prior `StrategistResearchResult` shape; the strategist receives an unchanged contract; ATS grades against `jd` keywords.
- A/B parity: re-run the same JD; the assembled brief should match the prior shape with no duplicate extraction (one JD pass in metrics).

## Out of scope

- The ATS feedback loop (Part B of the prior spec) — built next, on this clean architecture.
- Changing the matching algorithm or the KB retrieval mechanics.
- Merging the cover-letter / years-gap agents.

## Rollout

Single PR (the two agents move together — they share the contract). Deploy → re-run the same JD → confirm: one JD extraction (no duplicate `technologyInventory`), the assembled `research` brief intact, the strategist output unchanged-or-better.
