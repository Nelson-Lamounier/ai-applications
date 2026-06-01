# Phone Screen Prep Generation — Design (Spec 2a)

> **Date:** 2026-06-01
> **Status:** Approved design (brainstorming complete). Implementation plan next.
> **Scope:** Spec 2a of the Phone Screen program. Read-only **prep generation**:
> the Coach Agent emits phone-screen-specific prep grounded in the Spec-1 ontology,
> served + rendered. **Per-stage user-state persistence (compTarget/schedule/checks/
> notes → RDS) is Spec 2b — out of scope here.**
> **Depends on:** Spec 1 (`RdsStagePrepOntologyRepository`, migration 049) — PR #108.
> **Touches two repos:** `ai-applications` (coach) + `tucaken-app` (admin-api + UI).

## Why this exists

The Phone Screen workspace renders raw `research.verifiedMatches[].skill` strings as
"talking points," has no career-arc narrative, and a comp card with no content. The
Coach Agent already runs for the `phone-screen` stage and persists to
`coaching_content`, but emits only the generic per-stage fields (questions, notes).
This spec makes the Coach emit the three phone-screen-specific surfaces the workspace
needs — **career arc, JD-cross-referenced talking points, and a compensation script** —
each grounded in the Spec-1 ontology (what the stage tests, the company's process
shape, market comp benchmarks, gap-handling templates) and in the user's verified
evidence. The LLM fills slots the ontology defines; it does not invent scaffolding.

## Data flow (one pass, no new pipeline)

```
PhoneScreenWorkspace ──(compTarget, region)──▶ POST /:slug/coach
  └▶ K8s coach job env ──▶ run-coach:
       load analysis + research  (same pipeline_runs.metadata row)
       build RdsStagePrepOntologyRepository (Spec 1)
       resolve selectors, fetch constraints:
         getStageExpectation(companyType, roleFamily, 'phone-screen')
         getCompanyProfile(companyKey).processShape
         getCompBenchmark(roleFamily, seniority, region)
         listScaffolds('gap_handling')
       buildStagePrepConstraintBlock(...) → append to Coach system prompt
       Coach (Haiku 4.5) emits InterviewCoachResult + 3 optional phone-screen fields
  └▶ persistCoachingContent → coaching_content.topics_to_study (full result JSON)
  └▶ GET /:slug → coaching['phone-screen'].topics → PhoneScreenWorkspace renders
```

## 1. Coach schema extension (non-breaking, all stages share one schema)

The `emit_interview_coaching` tool schema is unified across stages (verified). Add three
**optional** fields — present in the tool `inputSchema.properties` but absent from
`required`, and `.optional()` in the Zod `CoachOutputSchema`. The persona prompt instructs
the model to emit them **only when `interviewStage === 'phone-screen'`**; every other
stage omits them and Zod validation passes unchanged.

- `careerArcSummary?: string` — a 2-3 sentence narrative of the candidate's trajectory.
- `jdTalkingPoints?: Array<{ point: string; evidence: string }>` — the candidate's
  strongest verified evidence cross-referenced against the JD.
- `compScript?: { targetEcho: string; marketContext: string | null; deflectTemplate: string }`
  — how to handle the compensation question. `marketContext` is `null` when no benchmark
  row exists (no invented numbers).

These are added to the shared `InterviewCoachResult` type
(`applications/shared/src/strategist-types.ts`) as optional fields.

**Forced tool-use note:** the Bedrock tool keeps `additionalProperties: false`. The model
can only emit the three fields because they are declared properties; making them
non-`required` is what allows non-phone stages to omit them without a validation error.

## 2. Ontology injection (the Spec-1-deferred constraint builder, now with a caller)

New module `applications/shared/src/stage-prep/constraint-block.ts` exporting
`buildStagePrepConstraintBlock(constraints): string`. It renders the fetched ontology
rows into a natural-language calibration block appended to the Coach system prompt —
mirroring `case-study-agent.buildSystemPrompt`. Guidance is **soft**: it shapes emphasis,
and the block ends with a truthfulness reminder ("calibration changes emphasis, never
truthfulness; omit anything you cannot ground").

`run-coach` resolves the selectors:

- `roleFamily = toRoleFamily(targetRole)` (Spec 1 helper)
- `companyKey = normalize(targetCompany)` → `getCompanyProfile(companyKey)`; `companyType`
  from the profile, else `'*'`
- `seniority` from `research.seniority` / `research.experienceSignals` → `toCompSeniority`
- `region` from the `/coach` request body, default `'eu-remote'`

then fetches `getStageExpectation`, the profile's `processShape`, `getCompBenchmark`, and
`listScaffolds('gap_handling')`. Every lookup is null-safe; the block omits absent pieces.

## 3. Synthesis (grounded, honest by construction)

- **careerArcSummary** ← `research.experienceSignals` + `research.fitSummary` + `analysisXml`.
  No resume/profile fetch — the strategist already analysed verified background.
- **jdTalkingPoints** ← `research.verifiedMatches` cross-referenced against the JD text.
- **compScript** ← user `compTarget` (from env) + `getCompBenchmark(...)`. When the
  benchmark is null, `marketContext = null` and the script is target echo + deflect
  template only — never a fabricated range (Spec 1 rule). Gap templates inform how the
  script (and notes) handle 🔴 evidence topics.

If `research` is missing from metadata (older runs), degrade gracefully: synthesise the
fields from `analysisXml` alone. The fields are optional, so partial output is valid.

## 4. Persistence — zero schema change

The three fields ride inside `InterviewCoachResult`. `persistCoachingContent` already
serialises the whole result into `coaching_content.topics_to_study`, and `GET /:slug`
already returns `coaching[stage].topics = topics_to_study`. **The entire serving path is
free** — no `coaching_content` migration, no admin-api serializer change.

## 5. Cross-cutting edits

**admin-api** (`tucaken-app/admin-api/src/routes/applications.ts`):
- `POST /:slug/coach` accepts optional `compensationTarget` (number/string) + `region`
  (string) in the body; forwards them as `COMPENSATION_TARGET` / `REGION` env vars on the
  K8s job. `env-coach.ts` parses them into the coach context.

**UI** (`tucaken-app/src/features/applications/stages/workspaces/PhoneScreenWorkspace.tsx`):
- Render `careerArcSummary` (new "Career arc" section), `jdTalkingPoints` (replaces the raw
  `verifiedMatches[].skill` bullet list), and `compScript` in the Comp Conversation card
  (market range when `marketContext` present, else target + deflect script).
- On coach dispatch, send `compTarget` (current localStorage value) + `region`.
- Extend `InterviewPrepOutput` (`tucaken-app/src/lib/types/applications.types.ts`) with the
  three optional fields.

## Cross-repo sequencing (two PRs)

1. **ai-applications PR first** — coach schema + `constraint-block.ts` + selector resolution
   + synthesis + `env-coach` parsing. Harmless before the UI ships: optional fields simply
   populate `coaching_content`.
2. **tucaken-app PR second** — admin-api `/coach` body + `PhoneScreenWorkspace` rendering +
   types. Depends on the ai-applications PR producing the fields.

The ai-applications PR also depends on Spec 1 (PR #108) being merged so
`RdsStagePrepOntologyRepository` is on `develop`.

## Testing

- `buildStagePrepConstraintBlock` — given a constraints object, asserts the rendered prose
  (focus areas, process shape, comp context, gap guidance; omits absent pieces).
- Selector resolution — `roleFamily`/`companyType`/`seniority`/`region` from sample
  analysis+research+body; default `region` when absent.
- Coach Zod schema — accepts phone-screen fields when present AND when absent (non-phone
  stages must still validate).
- `run-coach` loader — pulls `research` alongside `analysis`; degrades when `research` null.
- admin-api — `POST /:slug/coach` forwards `COMPENSATION_TARGET` / `REGION` env vars when
  supplied, omits them when not.

## Out of scope (this spec)

- Per-stage user-state persistence (`interview_stages.user_state`, PATCH endpoint, UI
  localStorage→RDS migration) — **Spec 2b**.
- An `/advance` endpoint / auto-dispatching the coach on stage advance — Spec 2b / later.
- Other stages' workspaces (Technical, Behavioural, …) — the ontology already supports
  them, but their wiring is separate work.
- Any change to `coaching_content` schema (not needed — fields ride in `topics_to_study`).
