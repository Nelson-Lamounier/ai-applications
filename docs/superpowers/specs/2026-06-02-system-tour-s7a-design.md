# System Tour — S7a (generation): Design

> **Date:** 2026-06-02 · **Status:** Approved design. Plan next.
> **Goal:** Generate a grounded, interview-ready "system tour" walkthrough per project — re-projecting an existing case study into the order a candidate would present in an architecture-review round.
> **Repo:** `ai-applications` (single PR). **Migration 063.** **Branch:** `feat/system-tour-s7a` off develop.
> **Seventh sub-project, part a** (S7a generation; S7b surfaces it in tucaken). Design-input §7.

## Reuse-first
The case-study agent already extracts the grounded ingredients per project: `decisions[]` (ADR-style), `challenges[]` (tradeoffs), `architecture` (Mermaid), `highlights[]` (outcomes). S7a is a **re-projection + narrative ordering** of those, plus one genuinely-new field (`whatIdChange`). It mirrors the case-study agent's forced-tool + grounding-verifier discipline (`case-study-agent.ts`, `runAgent<T>`, `IGroundingVerifier`).

## Components (single PR, ai-applications)

### A. `SystemTourSchema` (`applications/shared/src/projects/system-tour-types.ts`)
Zod, `.strict()`, mirrors `CaseStudySchema` conventions:
```ts
export const SystemTourSchema = z.object({
  area:        z.string().min(1).max(200),          // the system/component the tour walks
  context:     z.string().min(1).max(2000),         // problem + constraints (grounded)
  keyDecisions: z.array(z.object({                  // from case-study decisions
    decision: z.string(), rationale: z.string(),
  })).min(1).max(6),
  tradeoffs:   z.array(z.object({                   // from case-study challenges
    tension: z.string(), chosenPath: z.string(), cost: z.string(),
  })).max(6),
  systemMap:   ArchitectureSchema,                  // REUSE the case study's Mermaid architecture verbatim
  outcomes:    z.array(z.string()).max(6),          // from case-study highlights
  whatIdChange: z.array(z.string()).max(4),         // NEW — grounded improvements ONLY (may be [])
}).strict();
export type SystemTour = z.infer<typeof SystemTourSchema>;
```

### B. `system-tour-agent.ts` (`applications/shared/src/projects/`)
Mirrors `case-study-agent.ts`: a `SYSTEM_TOUR_TOOL` forced-tool def (from SystemTourSchema), `buildSystemTourSystemPrompt(caseStudy)`, and `executeSystemTourAgent(...) → runAgent<SystemTour>({tool, config, …})`. Input is the **already-generated `CaseStudy`** (the only evidence source). System prompt rules: ground EVERY element in the provided case study; `systemMap` = the case study's `architecture` reused verbatim; `whatIdChange` may ONLY draw on evidenced limitations (case-study `challenges`/`depthMarkers`) — if none, return `[]` (never invent regrets). Pass through the existing `IGroundingVerifier` like the case-study agent does.

### C. migration `063_project_system_tours.sql`
```sql
CREATE TABLE IF NOT EXISTS project_system_tours (
  project_id   UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content      JSONB NOT NULL,        -- the SystemTour payload
  content_hash TEXT NOT NULL,         -- input hash (case-study content) for cache/idempotency
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
(RLS: `projects` is the owning table; follow how project_* tables scope — if they rely on `projects` FK + app role, mirror that. Confirm in the plan.)

### D. `RdsSystemTourRepository` + orchestration hook
- Repo: `upsert(projectId, tour, contentHash)` + `getForProject(projectId)`.
- `runSystemTour(projectId, caseStudy, contentHash, {agent, verifier, cache?})`: compute hash over the case study; semantic-cache lookup (reuse `ISemanticCache` pattern, optional); else `executeSystemTourAgent`; persist via the repo. Generated **on-demand** from the persisted case study (NOT regenerating case studies). Where it's triggered (case-study orchestrator tail vs a separate entrypoint) is finalised in the plan — default: a function reusable by the case-study orchestrator so a fresh case study can also produce its tour.

## Data flow
```
existing CaseStudy (persisted per project)
  → runSystemTour → SYSTEM_TOUR agent (grounded, systemMap=architecture verbatim)
  → SystemTour → project_system_tours (upsert, content_hash)
(S7b) admin-api reads project_system_tours → ApplicationDetail → SystemDesignWorkspace
```

## Honesty
- Input is ONLY the grounded case study; the agent cannot introduce un-evidenced claims.
- `whatIdChange` is the sole new synthesis — restricted to evidenced limitations; `[]` when none (no fabricated regrets).
- `systemMap` reuses the case study's already-grounded Mermaid (no new architecture invented).
- Grounding verifier applied as in the case-study agent.

## Testing
- **A:** SystemTourSchema accepts a valid payload; rejects extra keys (`.strict`); `whatIdChange` optional-empty.
- **B:** `executeSystemTourAgent` parses a forced-tool response into `SystemTour`; the prompt instructs verbatim-architecture reuse + grounded whatIdChange (assert prompt contains the rules); a case study with no limitations → guidance yields `whatIdChange: []` (prompt-level; covered by a parse test on a `[]` response).
- **C:** migration applies; `project_system_tours` FK to projects; upsert/get round-trip (fakePool).
- **D:** `runSystemTour` persists; cache-hit path skips the agent.

## Decomposition
Single PR (ai-applications): SystemTourSchema + system-tour-agent + migration 063 + RdsSystemTourRepository + runSystemTour + tests.

## Out of scope (S7a)
admin-api serve + SystemDesignWorkspace render (S7b); a dedicated K8s job (reuse the case-study path/trigger); regenerating existing case studies.
