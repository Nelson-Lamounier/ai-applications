# System Tour — S7b (trigger + surface): Design

> **Date:** 2026-06-02 · **Status:** Approved design. Plan next.
> **Goal:** Make the system tour live — generate it when a case study is produced, and surface it in the Technical workspace for architecture-review / system-design rounds (filling the existing `SystemDesignWorkspace` stub).
> **Repos:** `ai-applications` (Part 1 trigger) + `tucaken-app` (Part 2 surface). No migration (`project_system_tours` shipped in S7a).
> **S7 part b.** Builds on S7a (`runSystemTour`, `bedrockSystemTourAgent`, `project_system_tours`).

## Part 1 — generation trigger (ai-applications, off develop; independent of tucaken)
S7a shipped `runSystemTour` but nothing calls it → the table is empty. Wire it into the case-study job:
- `run-case-study.ts` `main()`: after `runCaseStudyOrchestration(...)` succeeds and persists, call `runSystemTour(pool, { projectId: env.projectId, userId: env.userId, caseStudy: out.caseStudy, agent: bedrockSystemTourAgent, repo: new RdsSystemTourRepository(pool), cache?, ctx })`.
- **Fail-open**: wrap in try/catch — a tour failure logs + does NOT fail the case-study run (the case study is already persisted). Behind the same feature flag as the case-study run.
- Record the outcome in pipeline-run metadata (e.g. `systemTourGenerated: true/false`).

## Part 2 — surface (tucaken-app, off main AFTER #63/#64 merge)
**Dependency:** the `architecture-review` gate needs #64 (`VALID_ROUND_TYPES` + UI `technicalRoundType`). `system-design` works today. Build Part 2 off a main that has #64.
- **admin-api `GET /:slug`**: RLS-scoped (`withUser`) query of `project_system_tours` for the user (cap 3, newest first), mapped to a `SystemTour[]`; served on `ApplicationDetail.systemTours`. **Fail-open** (query error → omit). Always served when present (cheap); the UI decides where to show it.
- **UI types** (`applications.types.ts`): `SystemTour` (area, context, keyDecisions[], tradeoffs[], systemMap, outcomes[], whatIdChange[]) + `ApplicationDetail.systemTours?: SystemTour[]`.
- **`SystemDesignWorkspace`**: replace the "Your own system design work" stub with the tour walkthrough when `systemTours?.length` AND `technicalRoundType ∈ {system-design, architecture-review}` (or undefined safe-mode): render each tour — area heading, context, key decisions (decision + rationale), tradeoffs (tension/chosenPath/cost), the system map (reuse the existing Mermaid renderer if present, else the node/edge list), outcomes, "what I'd change". Keep the existing "review your case-studies" link as the empty-state fallback.

## Honesty
Only real generated tours (no fabrication — the tour content is already grounded by S7a's agent). Empty → the existing fallback, never a synthesized walkthrough. RLS-scoped read (a user only sees their own tours).

## Data flow
```
run-case-study job → runCaseStudyOrchestration (persists case study) → [Part 1] runSystemTour → project_system_tours
tucaken admin-api GET /:slug → [Part 2] read project_system_tours (RLS, cap 3) → ApplicationDetail.systemTours
SystemDesignWorkspace → render the walkthrough (gated on system-design/architecture-review)
```

## Testing
- **Part 1:** run-case-study calls `runSystemTour` with the produced case study after persistence; a `runSystemTour` throw does NOT fail the job (fail-open); metadata records the outcome.
- **Part 2:** admin-api returns `systemTours` from a mocked `project_system_tours` query (RLS via withUser); query failure → field omitted, 200; UI renders the walkthrough for system-design/architecture-review when tours present; shows the fallback when empty; does not render for unrelated round types where the section is gated.

## Decomposition (2 PRs)
- **PR1 (ai-applications):** Part 1 trigger + tests.
- **PR2 (tucaken-app, after #63/#64):** Part 2 admin-api serve + UI types + SystemDesignWorkspace render + tests.

## Out of scope
A dedicated tour-only regeneration job (reuses the case-study trigger); per-application project selection UI (serve the user's tours; cap 3); changing S7a's generation.
