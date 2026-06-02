# JD Pillar Classifier — S2: design

> **Date:** 2026-06-02
> **Status:** Approved design (brainstorming complete). Plan next.
> **Goal:** Classify a JD's interview-prep focus (multi-label) so the Technical workspace can indicate and emphasize the relevant pillar(s) — SWE-DSA, DevOps/SRE/Platform, AI-Engineering, or plain SWE — grounded in verbatim JD evidence, never asserted as ground truth.
> **Repos:** `ai-applications` (research agent + types) + `tucaken-app` (admin-api passthrough + UI chip/markers).
> **Design input:** `docs/superpowers/specs/2026-06-02-devops-ai-pillars-design-input.md` §5 + audit D.
> **Second of 8 sub-projects** (S2). No migration (lives in `pipeline_runs.metadata.research`).

## Why an LLM field (not a keyword classifier)

The research agent already parses the JD into a forced-tool structured brief. Adding one more inferred field reuses that pass and the model's nuance. A deterministic keyword classifier was rejected: brittle, and redundant with an agent that already reads the JD. Honesty is preserved by requiring **verbatim JD evidence tokens** for any specialized classification.

## Pillars (4, multi-label)

`primaryPillar ∈ { 'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering' }`
- **swe-general** — default/fallback: plain backend/full-stack with no specialized algorithm/infra/AI emphasis. Maps to today's generic workspace (no special section emphasized).
- **swe-dsa** — algorithm/data-structure coding emphasis (LeetCode-style).
- **devops-sre-platform** — Kubernetes/Terraform/cloud/SRE/on-call/reliability.
- **ai-engineering** — LLMs/RAG/embeddings/agents/evals/MCP/inference.

`secondaryPillars: string[]` — additional applicable pillars (a "Platform Engineer, AI infra" JD = primary devops-sre-platform + secondary ai-engineering).

## Components

### A. Research agent (`ai-applications/applications/job-strategist/src/agents/research-agent.ts`)
Add `pillarClassification` as an **optional** field. Because the tool schema is `additionalProperties: false` and `ResearchModelSchema` is `.strict()`, it MUST be added in **three** places or the safety-net parse fails:
1. `RESEARCH_TOOL.inputSchema.properties.pillarClassification` (object; its inner props in `required`, but `pillarClassification` itself **NOT** added to the top-level `required` array — so the model may omit it).
2. `ResearchModelSchema` — `pillarClassification: z.object({...}).strict().optional()`.
3. `StrategistResearchResult` (`applications/shared/src/strategist-types.ts`) — the optional readonly field.

Shape:
```ts
readonly pillarClassification?: {
  readonly primaryPillar: 'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering';
  readonly secondaryPillars: ReadonlyArray<'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering'>;
  readonly confidence: number;          // [0,1] JD-inference confidence
  readonly jdEvidenceTokens: string[];  // verbatim JD quotes that drove the classification
  readonly classificationNote: string;  // mandatory honesty note
};
```
Prompt addition (a short block in the existing research user message): "Classify the role's interview-prep focus from the JD LANGUAGE ONLY. primaryPillar = swe-general unless the JD clearly emphasizes algorithms (swe-dsa), infrastructure/SRE/platform (devops-sre-platform), or LLM/AI engineering (ai-engineering). Include every applicable pillar in secondaryPillars. Quote the verbatim JD phrases that drove the choice in jdEvidenceTokens (≥1 when primary≠swe-general). classificationNote must state this is inferred from JD language, not guaranteed." Signal hints per pillar: swe-dsa ("algorithms","data structures","LeetCode","coding interview","complexity"); devops ("on-call","incident","SLO","Terraform","Kubernetes","reliability","platform","troubleshooting"); ai ("LLM","RAG","embeddings","vector","prompt","evals","fine-tune","agent","MCP","inference").

Persisted automatically in `pipeline_runs.metadata.research` (no run-coach/RDS change).

### B. admin-api passthrough (`tucaken-app/admin-api/src/routes/applications.ts`)
In `normaliseResearch`, pass `pillarClassification` through **verbatim** when present (one block, mirroring the existing `dsaTopicCalibration` passthrough at lines 130–132).

### C. UI (`tucaken-app`)
- Type `PillarClassification` on `ResearchOutput` (`src/lib/types/applications.types.ts`).
- **TechnicalWorkspace** (`src/features/applications/stages/workspaces/TechnicalWorkspace.tsx`):
  - A **"Role focus" chip** near the top: the primary pillar's human label (+ secondary labels), with a tooltip/expander showing the verbatim `jdEvidenceTokens` and the `classificationNote`. Shown only when `pillarClassification` present and `primaryPillar !== 'swe-general'` (a general role needs no special chip) — or show a muted "General software role" chip for swe-general (decide in plan; default: show chip for non-general only).
  - A small **"Matches this role" marker** on the section the pillar points to: DSA section when pillar set includes `swe-dsa`; DevOps section when it includes `devops-sre-platform`. (AI section is S4 — not built; the chip still lists ai-engineering.)
  - **No reordering, no hiding** — existing section gates (round_type/evidence) are untouched; the pillar only labels + emphasizes. Honest: an inference must not filter out real evidence.
  - Pillar→label map + pillar→section-key map are small constants in the workspace.

## Data flow
```
research agent (analysis) → research.pillarClassification → pipeline_runs.metadata.research
admin-api GET /:slug → normaliseResearch passthrough → research.pillarClassification
TechnicalWorkspace → "Role focus" chip (+ jdEvidenceTokens tooltip) + "matches this role" section markers
```

## Error handling & honesty guardrails
- Optional everywhere: absent `pillarClassification` → no chip, no markers, today's behavior (fail-open).
- `jdEvidenceTokens` required (≥1) whenever `primaryPillar !== 'swe-general'`; the chip surfaces them so the user sees WHY.
- Chip copy frames classification as "inferred from the JD", never a guarantee.
- The classifier never hides a section — existing gates remain authoritative.
- Schema discipline: added to inputSchema.properties (not required) + ResearchModelSchema `.optional()` + the TS type, so omission by other stages and older runs parses cleanly.

## Testing
- **A:** research agent emits a valid `pillarClassification` (schema accepts present AND absent); multi-label secondaries; a JD with no specialized signal → `swe-general`; a DevOps JD → `devops-sre-platform` with ≥1 evidence token; `ResearchModelSchema.safeParse` passes with and without the field.
- **B:** `normaliseResearch` passes `pillarClassification` through when present; omits when absent.
- **C:** chip renders with primary+secondary labels + evidence tooltip when present and non-general; no chip when absent or swe-general (per chosen rule); "matches this role" marker appears on the DSA/DevOps section for the matching pillar; sections are NOT reordered or hidden.

## Decomposition (2 PRs)
- **PR1 (`ai-applications`):** research agent `pillarClassification` (3 schema places) + prompt block + `StrategistResearchResult` type + tests.
- **PR2 (`tucaken-app`):** admin-api passthrough + UI type + Role-focus chip + section markers + tests.

## Out of scope (S2)
- AI pillar section (S4) and its gating; round_type-based gating (S5); coach prompt awareness of pillar (could be a tiny later add — not S2); any reordering/hiding of workspace sections.
