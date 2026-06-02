# System Tour S7a (generation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Generate + persist a grounded `SystemTour` per project by re-projecting the existing case study.

**Architecture:** Mirror the case-study agent (forced-tool + `runAgent<T>` + `IGroundingVerifier`). Input = persisted `CaseStudy`; output = `SystemTour` → `project_system_tours` (migration 063). On-demand, no case-study regeneration.

**Tech Stack:** TypeScript, Zod, Bedrock forced-tool, pg, Jest. **Spec:** `docs/superpowers/specs/2026-06-02-system-tour-s7a-design.md`. **Branch:** `feat/system-tour-s7a` off develop. **Templates:** `applications/shared/src/projects/{case-study-agent.ts, case-study-types.ts, case-study-orchestrator.ts, case-study-persistence.ts}`.

---

## Task 1: `SystemTourSchema` + types (TDD)
**Files:** Create `applications/shared/src/projects/system-tour-types.ts`; Test `…/system-tour-types.test.ts`.
- [ ] Read `case-study-types.ts` (esp. `ArchitectureSchema`, the `.strict()` convention, the barrel export).
- [ ] Write failing test: `SystemTourSchema.safeParse` accepts a valid payload (area/context/keyDecisions≥1/tradeoffs/systemMap=ArchitectureSchema/outcomes/whatIdChange) ; rejects an unknown key ; accepts `whatIdChange: []`.
- [ ] Implement `system-tour-types.ts` per spec §A (import + reuse `ArchitectureSchema` from case-study-types). Export `SystemTourSchema` + `SystemTour`. Add to the projects barrel if one exists.
- [ ] Run → pass; `npm run build -w applications/shared` clean.
- [ ] Commit: `feat(projects): SystemTourSchema (system-tour-types)`

## Task 2: `system-tour-agent.ts` (TDD)
**Files:** Create `applications/shared/src/projects/system-tour-agent.ts`; Test `…/system-tour-agent.test.ts`.
- [ ] Read `case-study-agent.ts` fully — mirror: the `CASE_STUDY_TOOL` forced-tool object → `SYSTEM_TOUR_TOOL` (inputSchema from SystemTourSchema fields), `buildSystemPrompt` → `buildSystemTourSystemPrompt(caseStudy: CaseStudy)`, and the `executeCaseStudyAgent` → `executeSystemTourAgent(input)` calling `runAgent<SystemTour>({ tool: SYSTEM_TOUR_TOOL, config, systemPrompt, userMessage, parseResponse })`. Reuse `parseJsonResponse` + a Zod `safeParse` validate (fail-fast) exactly like the case-study agent.
- [ ] System prompt rules (assert in tests): "ground every element in the PROVIDED case study only"; "systemMap MUST be the case study's architecture reused verbatim"; "whatIdChange may ONLY cite evidenced limitations (challenges/depthMarkers); return [] if none — never invent regrets".
- [ ] Write failing tests: (a) a forced-tool JSON response parses+validates into `SystemTour`; (b) an invalid (extra-key / missing area) response → throws (fail-fast); (c) the system prompt contains the verbatim-architecture + grounded-whatIdChange rules. Mirror case-study-agent.test.ts mocking of `runAgent`/the model.
- [ ] Implement. Run → pass. Build clean.
- [ ] Commit: `feat(projects): system-tour-agent (forced-tool, grounded re-projection of the case study)`

## Task 3: migration 063 + `RdsSystemTourRepository` (TDD)
**Files:** Create `applications/platform-rds-bootstrap/migrations/063_project_system_tours.sql`; `applications/shared/src/projects/system-tour-persistence.ts` (or extend an existing projects repo — check); Test `…/system-tour-persistence.test.ts`.
- [ ] Read `case-study-persistence.ts` + an existing `project_*` migration (e.g. `project_architecture`) for the RLS/ownership pattern (FK to projects + app role). Mirror it.
- [ ] Write migration 063 per spec §C (`project_system_tours`: project_id PK FK→projects, content JSONB, content_hash TEXT, generated_at). Match the RLS approach the other `project_*` tables use.
- [ ] Apply to dev (ephemeral psql pod); verify table + FK.
- [ ] Write failing test for `RdsSystemTourRepository.upsert(projectId, tour, hash)` (sets scope if the other project repos do; INSERT … ON CONFLICT (project_id) DO UPDATE) + `getForProject(projectId)` round-trip (fakePool).
- [ ] Implement repo. Run → pass. Build clean.
- [ ] Commit: `feat(projects): project_system_tours table (migration 063) + RdsSystemTourRepository`

## Task 4: `runSystemTour` orchestration (TDD)
**Files:** Create `applications/shared/src/projects/system-tour-orchestrator.ts`; Test `…/system-tour-orchestrator.test.ts`.
- [ ] Read `case-study-orchestrator.ts` (load → cache → agent → persist + `computeInputHash`). Mirror a lean version.
- [ ] `runSystemTour({ projectId, caseStudy, agent, verifier?, cache?, ctx })`: hash the case study (`computeInputHash`-style over `caseStudy`); optional `cache.get(hash)`; else `executeSystemTourAgent`; `repo.upsert(projectId, tour, hash)`; return `{ cacheHit, tour, inputHash }`.
- [ ] Write failing tests: generates + persists when no cache; cache-hit short-circuits the agent (agent mock NOT called); verifier applied if provided. Mirror case-study-orchestrator.test.ts mocks.
- [ ] Implement. Run → pass.
- [ ] Commit: `feat(projects): runSystemTour orchestration (cache → agent → persist)`

## Final
- [ ] `npm test -w applications/shared` green; `npm run build -w applications/shared` clean.
- [ ] Final code-reviewer (focus: grounding — input is ONLY the case study; systemMap reuses architecture verbatim; whatIdChange grounded/empty not invented; fail-fast validation; cache short-circuit; RLS parity with project_* tables).
- [ ] PR (base develop). Body: S7a generation only; S7b (admin-api serve + SystemDesignWorkspace render) is the next spec; migration 063 above the open 057–062 PRs; deploy 063 before the projects pipeline.

## Out of scope
admin-api serve + UI render (S7b); a dedicated K8s job (reuse case-study trigger); case-study regeneration.
