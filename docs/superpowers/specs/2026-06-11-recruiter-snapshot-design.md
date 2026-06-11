# Recruiter Snapshot — design

**Date:** 2026-06-11
**Status:** Approved (design) — pending implementation plan
**Repos:** `ai-applications` (job-strategist pipeline), `tucaken-app` (admin-api + UI)

## Goal

After a tailored resume + cover letter are generated, return a concise
**recruiter snapshot** that answers, in a 10-second-read form:

- **Match score** — a single 0–100 number for "how well does this resume fit the JD".
- **Top 5 missing keywords** — the JD terms most worth adding.
- **3 red flags** — what a hiring manager would notice against this resume in under 10 seconds.

This is an assessment **of** the tailored resume, surfaced in the app. It is never
written into the resume or cover letter documents the user sends out.

## Decisions (locked during brainstorming)

1. **Score = hybrid** — a deterministic computed baseline, then an LLM nudge of ±10 with a one-line rationale.
2. **Placement = new app panel** — a "Recruiter Snapshot" panel in the application results view, alongside the ATS panel and fit section. Persisted in `pipeline_runs.metadata`, never in the documents.
3. **Keywords + flags = LLM-selected, grounded** — the model picks the top 5 missing keywords (grounded in ATS keyword coverage + JD-extractor required skills) and the 3 sharpest red flags (grounded in the analysis's existing `red_flags_and_ambiguities` + research gaps). Recruiter-framed, prioritized.
4. **Generation = new post-ATS step** — the snapshot is produced after `renderCheckAndStoreAts`, because the computed baseline needs the ATS keyword coverage, which only exists after the writer renders and the ATS check runs. A cheap Haiku forced-tool agent does the nudge + selection. The 6-minute Sonnet writer is untouched.

### Why not extend the Sonnet writer

The writer runs *before* the ATS check, so it has no keyword-coverage data — its
keywords would come from research gaps, not the rendered resume, and the score
could not be hybrid. It would also bloat the most expensive call in the pipeline.

## Data model

```ts
interface RecruiterRedFlag {
  flag: string;   // the thing a recruiter notices, short
  why:  string;   // one line: why it reads as a flag
}

interface RecruiterSnapshot {
  score:          number;            // 0–100, integer (clamped)
  scoreRationale: string;            // one line explaining the score
  missingKeywords: string[];         // exactly 5 (or fewer if the JD yields fewer)
  redFlags:        RecruiterRedFlag[]; // exactly 3 (or fewer if grounding yields fewer)
}
```

Persisted at `pipeline_runs.metadata.analysis.recruiterSnapshot` (the durable
metadata block, same place ATS check now lives). No new DB column.

## Scoring

**Computed baseline** (deterministic, weights are constants, tunable in one place):

```text
keywordCoverage = atsCheck.jdKeywordCoverage present / total            // 0..1
verifiedRatio   = verifiedMatches / (verifiedMatches + gaps)            // 0..1, 0 if denom 0
hardReqHit      = hard requirements present in verifiedMatches / hardRequirements // 0..1, 1 if none

baseline = round( 100 * (0.5*keywordCoverage + 0.3*verifiedRatio + 0.2*hardReqHit) )
```

**LLM nudge**: the Haiku agent returns an integer delta in `[-10, +10]` with a
rationale. Final `score = clamp(baseline + delta, 0, 100)`.

Sanity check against the last live run (6 verified, 5 gaps, ~partial keyword
coverage) → baseline lands in the mid-40s, consistent with the observed STRETCH /
~45 fit.

## Generation step

New file: `applications/job-strategist/src/agents/recruiter-snapshot.ts`

```ts
export async function buildRecruiterSnapshot(
  ctx: StrategistPipelineContext,
  research: StrategistResearchResult,
  atsCheck: AtsCheckResult | null,
): Promise<RecruiterSnapshot | null>
```

- Computes the baseline (pure function, unit-testable in isolation).
- Builds a grounded prompt: ATS `not present` terms + JD-extractor required skills → "pick the 5 most impactful missing keywords"; analysis `red_flags_and_ambiguities` + research `gaps` → "pick the 3 sharpest red flags a recruiter notices in 10 seconds, recruiter-framed".
- Calls a Haiku forced-tool agent (same pattern as `jd-extractor`) that emits `{ scoreDelta, scoreRationale, missingKeywords, redFlags }`, validated by a Zod schema.
- **Fail-open**: any throw, or `atsCheck === null`, returns `null`. The pipeline never fails because of the snapshot.

### Wiring (`run-pipeline.ts`)

Immediately after `renderCheckAndStoreAts` returns `atsCheck`:

```ts
const recruiterSnapshot = await buildRecruiterSnapshot(ctx, research.data, atsCheck)
  .catch(() => null);
```

Add `recruiterSnapshot` to the metadata stash:

```ts
analysis: { ...analysis.data, analysisXml: finalAnalysis, pathGrounding, atsCheck, recruiterSnapshot }
```

## Surface + UI (`tucaken-app`)

- **admin-api** `routes/applications.ts`: add to the analysis mapping
  `recruiterSnapshot: rawAnalysis['recruiterSnapshot'] ?? null`.
- **types** `lib/types/applications.types.ts`: `RecruiterSnapshot`, `RecruiterRedFlag`; add `recruiterSnapshot?: RecruiterSnapshot | null` to `AnalysisOutput`.
- **component** `features/applications/stages/components/RecruiterSnapshotPanel.tsx`:
  - score ring / big number, colour band: `<50` red, `50–69` amber, `≥70` green; `scoreRationale` under it.
  - "Top missing keywords" — chips (reuse the chip styling from `JdUnderstandingPanel`).
  - "3 red flags · 10-second read" — list of `{flag, why}`.
  - `rounded-md`, dark-mode correct, follows existing panel conventions.
- **placement** `AppliedWorkspace.tsx`: render `{recruiterSnapshot ? <RecruiterSnapshotPanel .../> : null}` above the ATS panel.

## Testing

`ai-applications`:
- `recruiter-snapshot.test.ts`:
  - baseline math: known `(coverage, verified, gaps, hardReqs)` → expected baseline.
  - clamp: baseline 95 + delta 10 → 100; baseline 5 + delta −10 → 0.
  - Haiku mock → snapshot assembled with delta applied + keywords/flags passed through.
  - fail-open: `atsCheck = null` → `null`; agent throws → `null`.

`tucaken-app`:
- admin-api mapping test: `recruiterSnapshot` present in metadata → returned; absent → `null`.
- panel test: renders score + keywords + flags when present; renders nothing when null.

## Fail-open / safety

- Snapshot is purely additive and advisory. A `null` snapshot hides the panel; nothing else changes.
- Grounded selection only — no fresh/ungrounded keyword or flag generation.
- Haiku cost ~$0.006/run; adds ~5–8s after the ATS step (off the Sonnet critical path).

## Out of scope

- No new DB column or migration (lives in existing metadata JSON).
- No change to the resume/cover-letter documents themselves.
- No re-scoring of historical runs (applies to new runs only).
- Weight tuning beyond the initial constants (revisit after a few runs if the score feels off).

## File list

**ai-applications** (`feat/recruiter-snapshot`)
- `applications/job-strategist/src/agents/recruiter-snapshot.ts` (new)
- `applications/job-strategist/src/agents/recruiter-snapshot.test.ts` (new)
- `applications/job-strategist/src/run-pipeline.ts` (wire + metadata stash)
- Zod schema for `RecruiterSnapshot` — colocated in `recruiter-snapshot.ts` and used to validate the Haiku output. The tucaken UI mirrors the shape as a plain TS type in `applications.types.ts` (the existing cross-repo pattern — `AtsCheckResult` is likewise defined independently in both repos, not shared via a package).

**tucaken-app** (separate branch off `main`)
- `admin-api/src/routes/applications.ts` (mapping)
- `src/lib/types/applications.types.ts` (types)
- `src/features/applications/stages/components/RecruiterSnapshotPanel.tsx` (new)
- `src/features/applications/stages/workspaces/AppliedWorkspace.tsx` (render)
- tests for the above
