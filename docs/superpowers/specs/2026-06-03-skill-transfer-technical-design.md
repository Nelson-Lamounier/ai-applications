# Skill-Transfer / Project-Reference (Technical phase) — Design

> **Date:** 2026-06-03 · **Status:** Approved design. Plan next.
> **Goal:** In the Technical interview phase, map each JD skill to the user's actual project work — *"Stripe JD requires X; in your AI Applications Platform you did X (concept applied / skill transfer)"* — and honestly flag JD skills not demonstrated in any project. Grounded in real case-study + repo-evidence rows; no LLM invention.
> **Repos:** ai-applications (compute + coach + persist) + tucaken-app (serve + UI). **Branch:** `feat/skill-transfer-technical` off develop (ai-app).

## Problem (from review)
Today the coach agent receives only `research` (repo-scanned JD skills), `analysis`, JD, and stage-prep constraints — **not** the user's curated project case-studies. So the Technical checklist is generic. The UI "Your project reference sheet" + `EvidenceCard.projectRefs` are hardcoded empty placeholders (`workspace.ts` — *"BACKEND: follow-on (topic→project linkage)"*). The user has fully-built case studies (`project_decisions/highlights/challenges/components/stack_items/depth_markers/tags`, + `project_repositories` linking repos) that the interview-prep pipeline never joins.

## Approach — hybrid, grounded-by-construction
A **pure deterministic candidate-gatherer** bounds what the LLM may claim; the **coach LLM** picks the honesty tier and writes the narrative, citing only rows it was given. A post-validation drops any cited id not in the candidate set. Fuzzy matching therefore affects only *recall* (a missed match = honest under-claim) — never invention.

## Data flow
```
research (verifiedMatches+partialMatches+gaps) ─► JD-skill set (canonical, deduped, lowercased)
projects + case-study tables ─┐
repo evidence (technology/dsa/ai_evidence ├─► joinSkillCandidates()  [PURE, unit-tested]
  via project_repositories)   ┘     → per JD skill: candidate rows {projectId, projectName, source, id, label, fileLine?}
        │
        ▼ (injected into coach user message)
coach agent (Sonnet): per skill choose tier + narrate FROM candidates only
        │  validateSkillTransfer(): drop entries whose projectId/evidenceRefs[].id ∉ candidates
        ▼
coaching_content.skill_transfer (JSONB) ─► admin-api serve ─► Technical workspace
```

## Components

### A. `joinSkillCandidates(...)` — pure (ai-applications `shared/src/stage-prep/`)
Inputs: `jdSkills: string[]`, the user's `projects` (id, name), their case-study rows (stack_items, tags, components, decisions, depth_markers), and repo-evidence rows (technology/dsa/ai_evidence) joined to projects via `project_repositories`.
Per JD skill → candidate rows by **normalized token match** (reuse `technology_ontology` canonicalization for tech tokens; word-boundary token overlap for free-text skills — precision over recall, same FP discipline as the comparator audit). Each candidate tagged by source tier:
- `stack_items` / `tags` → **claimed** (listed, not shown)
- `components` / `decisions` / `depth_markers` → **demonstrated** (the actual thing built/decided)
- `technology/dsa/ai_evidence` → **declared@file:line** (repo receipt)
- no candidates → **gap**

Returns per-skill `{ jdSkill, candidates: [{projectId, projectName, source, id, label, fileLine?, tier}] }`. **Grounding lives here** — every id the LLM may cite originates from this set.

### B. Coach schema += `skillTransfer[]` (coach-agent.ts + shared strategist-types)
Each entry: `{ jdSkill, tier: 'demonstrated'|'claimed'|'declared'|'gap', projectId: string|null, projectName: string|null, evidenceRefs: [{source, id, label, fileLine?}], narrative }`.
- matched: `narrative` = the transfer story ("you did X in <project> → maps to the JD's X").
- `gap`: `projectId`/`projectName` null, `evidenceRefs` [], `narrative` = honest bridge guidance.
Zod `.strict()`. **`validateSkillTransfer(entries, candidates)`** (pure, tested) drops any entry whose `projectId` or `evidenceRefs[].id` is not in the candidate set for that skill (anti-invention).

### C. `run-coach` wiring (technical stage only)
Load the user's projects + case-study rows + repo-evidence-via-`project_repositories`; build `jdSkills` from research (verified+partial+gaps); `joinSkillCandidates(...)`; inject a compact candidate block into the coach message. The existing `technicalPrepChecklist` rationale also becomes **project-aware** (prompt instructs: reference the matched project when a checklist topic maps to one). Fail-open: any error → coach runs without skill-transfer (checklist still produced).
**No-projects rule:** if the user has zero projects/case-studies, omit `skillTransfer` entirely (no all-gap wall). Projects exist but a skill unmatched → per-skill `gap`.

### D. Persistence — migration: `coaching_content.skill_transfer JSONB NULL`
No new table; rides the existing per-stage `coaching_content` row. `persistCoachingContent` writes it.

### E. admin-api serve (tucaken-app)
`GET /:slug/coaching/:stage` + the detail assembly include `skillTransfer` on the technical stage payload; add the type to `applications.types.ts` (matching the contract — see the suggestedResources cross-repo-drift lesson, update BOTH repos' types together).

### F. UI (tucaken-app Technical workspace)
- New **"JD skills ↔ your projects"** section: per skill, a tier badge (demonstrated/claimed/declared/gap) + matched project + `narrative`; gaps rendered explicitly with the honest bridge text.
- Populate **"Your project reference sheet"**: rank the user's projects by demonstrated+declared coverage count (how many JD skills each covers), replacing the placeholder.
- `EvidenceCard.projectRefs` may reuse the same data (secondary; can be follow-on if it bloats the PR).

## Honesty
Tier precedence demonstrated > declared > claimed > gap. Gaps always shown, never hidden, never invented (id-validation). Matches existing two-tier display norm.

## Testing
- `joinSkillCandidates`: classification per source→tier; no-candidate→gap; token precision (no spurious matches); free-text + tech-canonical skills.
- `validateSkillTransfer`: drops invented projectId/evidenceRef ids; keeps valid.
- `run-coach`: fail-open (throw → no skill-transfer, checklist intact); no-projects → omitted.
- UI (RTL): section renders tiers + narrative; gap state; ranked reference sheet; empty/no-projects state.

## Decomposition (3 PRs)
1. **ai-applications** (`feat/skill-transfer-technical`): `joinSkillCandidates` + `validateSkillTransfer` + coach schema/prompt + run-coach wiring + migration (`skill_transfer` column) + persist + tests. Assumes coach on Sonnet (PR #66).
2. **tucaken-app admin-api**: serve `skillTransfer` + `applications.types.ts` type. (off main)
3. **tucaken-app UI**: new section + project reference sheet wiring (+ optional EvidenceCard.projectRefs) + RTL tests. (off main)

## Out of scope (v1)
Recompute-on-project-change (it rides coach runs); skill-transfer for non-technical stages; `EvidenceCard.projectRefs` if it bloats PR 3 (follow-on); a dedicated skill_transfer table (reuse coaching_content).
