# Years-Gap computation — design

**Date:** 2026-06-11
**Status:** Approved (design) — pending plan
**Repos:** `ai-applications` (pipeline), `tucaken-app` (admin-api + UI)

## Goal

For a seniority-stretch candidate, surface an honest **years-gap**: the candidate's
**relevant** years (the union of time spans of roles that legitimately count toward
the JD's experience requirement) vs the JD's required years, plus a **true,
non-apologetic framing line** the writer uses to lead the summary.

Driving example: a JD wants "8+ years (user operations, technical support, or
support engineering)". The candidate's literal "3+ years at AWS" undersells —
Meta QA content-ops (2021–2022) + AWS support (2022–present) is **~5 years across
operations and support**. Framing the summary as "5 years across user operations,
technical support, and content operations" is **true**, narrows the perceived gap,
and stops ~5 years being disqualifying when paired with the lower (5+) req. It
must never claim 8, never invent.

## Data model

`YearsGap`, persisted at `pipeline_runs.metadata.analysis.yearsGap`:
```ts
interface YearsGap {
  relevantYears:      number;        // union-of-spans of the relevant roles (1 decimal)
  requiredYears:      number | null; // parsed from research yearsExpected; null if absent
  gapYears:           number;        // max(0, required - relevant), 0 if requiredYears null
  disqualifying:      boolean;       // gapYears > 0 AND the JD years bar is flagged disqualifying
  relevantRoleTitles: string[];      // the roles the framing aggregates
  framingLine:        string;        // "5 years across user operations, technical support, and content operations"
}
```

## Computation — `years-gap.ts` (new), two parts

### 1. Deterministic (pure, unit-tested)
- `parsePeriod(period: string): { startYear: number; endYear: number } | null` — handles
  `"2022 - Present"`, `"2021 - 2022"`, `"September 2022 - September 2024"`,
  `"2022 - Present (Part-time)"`. `Present`/`Current` → the current year (passed in as
  `nowYear` for testability, NOT `new Date()` inside — scripts ban argless Date). Year
  extracted via the first 4-digit run on each side. Returns null when unparseable.
- `unionYears(intervals: {startYear,endYear}[]): number` — merge overlapping intervals,
  sum the merged lengths, round to 1 decimal. (So AWS + Freelance 2022–present overlap
  counts once.)
- `parseRequiredYears(yearsExpected: string): number | null` — `"8+"`→8, `"3-5"`→3
  (lower bound = the floor to clear), `"5"`→5, `""`/unparseable → null.

### 2. Smart relevance + framing (Haiku forced-tool, fail-open)
`yearsRelevanceAgent(input): { relevantTitles: string[]; framingLine: string } | null`
- **Input:** the JD target role + `yearsExpected` context + each candidate role as
  `{ title, company, periodYears, family, roleClass }` (family/roleClass from the role
  ontology resolution — that's the "smart" signal: QA `hybrid` + support `customer_facing`
  both count toward an operations/support JD).
- **Output:** the subset of role titles that legitimately count toward the JD's
  experience requirement, and a single true framing line aggregating their breadth +
  the union-years number. **Rules:** only include roles that genuinely relate; the line
  is a true re-description, never an invented total; never claim the required number;
  never apologise.

### Assembly — `buildYearsGap(careerEntries, resolvedRoles, yearsExpected, nowYear)`
1. parse each role's period → interval (+ per-role years).
2. call the Haiku relevance agent → relevant titles + framing line.
3. `relevantYears = unionYears(intervals of the relevant roles)`.
4. `requiredYears = parseRequiredYears(yearsExpected)`.
5. `gapYears = requiredYears == null ? 0 : max(0, requiredYears - relevantYears)`.
6. `disqualifying` = `gapYears > 0` AND a hard requirement whose context mentions years
   is flagged `disqualifying` (passed in from `research.hardRequirements`).
7. **Fail-open:** any throw, or the agent returning null → return `null` (no yearsGap;
   pipeline unaffected). If the agent fails but parsing succeeds, fall back to ALL
   parseable roles for `relevantYears` and a plain framing line ("N years of
   experience") so a number is still surfaced.

## Wiring (fail-open)

- **`run-pipeline`** — after research + `resolveRoleFamilies`, compute
  `yearsGap = await buildYearsGap(careerEntries, resolvedRoles, research.data.experienceSignals.yearsExpected, NOW_YEAR).catch(() => null)` and add `yearsGap` to the
  `metadata.analysis` stash; pass it to `executeStrategistAgent`.
  `NOW_YEAR` comes from the existing pipeline start timestamp (already a `Date` in
  run-pipeline), not a fresh argless `Date`.
- **Strategist persona** — add a rule: *"When YEARS GAP framing is present, lead the
  professional summary with the aggregated relevant-experience framing line; do not
  state a single-role tenure that undersells the candidate; never name or apologise for
  any shortfall."* Inject `yearsGap.framingLine` into the strategist user message
  (guarded) next to the role evidence.
- **admin-api** — map `yearsGap: rawAnalysis['yearsGap'] ?? null` into the analysis
  response (same pattern as `atsCheck` / `recruiterSnapshot`).
- **UI** — surface in the application view (a small line in the recruiter snapshot or
  fit section): `relevantYears` / `requiredYears` + the framing line. Hidden when null.

## Honesty guarantees
- Relevant-years = union of *actual* employment spans of roles the LLM judged relevant
  — no fabricated time. The framing line is a true re-description, validated to contain
  the computed number, never the required number unless it equals relevant.
- The recruiter snapshot / fit rating already score against unmet hard requirements; the
  years-gap is an additional honest signal + a framing lever, not a score inflator.

## Out of scope
- "Smallest-gap requirement targeting" (aim at the 5+ req not the 8+) — the deferred
  candidate-class / structural-strategy spec.
- Month-precision parsing (year granularity is sufficient for the framing).

## File list
**ai-applications** (`feat/years-gap`)
- `applications/job-strategist/src/agents/years-gap.ts` (pure helpers + Haiku agent + `buildYearsGap`)
- `applications/job-strategist/src/agents/years-gap.test.ts`
- `applications/job-strategist/src/run-pipeline.ts` (compute + stash + pass)
- `applications/job-strategist/src/agents/strategist-agent.ts` (`StrategistAgentInput.yearsGap` + message inject)
- `applications/job-strategist/src/prompts/strategist-persona.ts` (senior-stretch framing rule)
- `applications/shared/src/types.ts` (`AgentName += 'years-relevance'`)

**tucaken-app** (`feat/years-gap`)
- `admin-api/src/routes/applications.ts` (mapping)
- `src/lib/types/applications.types.ts` (`YearsGap` type + `AnalysisOutput.yearsGap`)
- `src/features/applications/stages/components/` (surface the line; small)
- tests for the above
