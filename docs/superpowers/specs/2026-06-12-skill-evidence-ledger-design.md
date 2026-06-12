# Skill Evidence Ledger — design

**Date:** 2026-06-12
**Status:** Approved (design) — building on `feat/jd-agent-consolidation` (#190)

## Goal

For each JD-required tool/skill, produce a **file-cited** evidence row that proves — to the company AND the user — whether the candidate's scanned repos demonstrate it: `verified` (with the exact `file_path`), `transferable` (the bridging evidence), or `gap` (honest, omitted). This turns the aggregate "Retrieval relevance" into a **per-tool** map and feeds the ATS feedback loop (#3).

## Problem (proven on run `a52c96fe`)

The matcher already verifies skills with PROSE, project-level citations (`VerifiedMatch.sourceCitation = "AI Applications Platform — case distribution automation system"`) but does NOT point to the specific KB `file_path`. The KB passages backing it DO carry `file_path` (the retrieval pulled `PROJECT_IMPLEMENTATION_REVIEW.md`, etc.), but it's never surfaced per skill. `kbRetrievalStats.topSources` is aggregate, not per-tool.

## Design

### 1. File citations on matches (matcher)
- `VerifiedMatch` + `PartialMatch` gain `evidenceFiles: string[]` — the KB `file_path`(s) that back the match.
- The KB passages already prefix each chunk with its source line (`source: <repo>/<file_path>`); the matcher reads it. Persona rule: "When a match is backed by a KB passage, put that passage's exact `file_path` in `evidenceFiles`. Empty array when the evidence is career-history (no file)." Fail-open: missing → `[]`.

### 2. The ledger (deterministic, pure)
`buildSkillEvidenceLedger(tools: string[], matching: ResearchMatching): SkillEvidenceEntry[]`
```ts
export type EvidenceStatus = 'verified' | 'transferable' | 'gap';
export interface SkillEvidenceEntry {
    readonly tool: string;               // the JD-required tool/skill
    readonly status: EvidenceStatus;
    readonly evidenceFiles: string[];    // file_paths proving it ([] for gap)
    readonly evidence: string;           // implementation description (from the match)
    readonly transferableBridge: string; // how it bridges (status='transferable'), else ''
}
```
- Input `tools` = `jdSignal.technologyInventory.tools` ∪ `requiredSkills` (the JD's required tools), deduped.
- For each tool: find a `verifiedMatch` whose skill matches the tool (reuse `matchTier1`/`normalizeTerm` from `ats/keyword-match.ts` — "Python" matches "Scripting and automation (Python/Bash)") → `verified` (evidenceFiles + sourceCitation as evidence). Else a `partialMatch` → `transferable` (evidenceFiles + transferableFoundation as bridge). Else → `gap` (empty).
- Pure + deterministic + unit-tested. No LLM.

### 3. Wiring
- `ResearchMatching`/`StrategistResearchResult` gain `skillEvidenceLedger: SkillEvidenceEntry[]` — built in run-pipeline (deterministic) from `jdSignal` + `matching`, after assembly.
- Stash in `metadata.analysis` (or `metadata.research`) for the UI.
- The writer message can reference the ledger (verified tools → lead with their evidence; never claim `gap` tools).

### 4. "Retrieval relevance" panel becomes per-tool (UI follow-up, tucaken)
admin-api maps `skillEvidenceLedger`; the UI renders per-tool: tool · status · file links · evidence · relevance. Out of scope for this PR (ai-applications only); tracked as the tucaken follow-up.

## Honesty
- `evidenceFiles` only ever contains files the matcher actually used as evidence — never fabricated. `gap` rows stay empty + are omitted from the resume. The ledger is the audit trail: every "verified" claim has a file behind it.

## File list (ai-applications, on #190 branch)
- `applications/shared/src/strategist-types.ts` — `evidenceFiles` on VerifiedMatch/PartialMatch; `EvidenceStatus`, `SkillEvidenceEntry`; `skillEvidenceLedger` on ResearchMatching + StrategistResearchResult.
- `applications/job-strategist/src/agents/research-agent.ts` + `prompts/research-persona.ts` — `evidenceFiles` in the match schema + the cite-the-file rule.
- `applications/job-strategist/src/ats/skill-evidence-ledger.ts` (new) + test — `buildSkillEvidenceLedger`.
- `applications/job-strategist/src/run-pipeline.ts` — build + stash the ledger.

## Testing
- `buildSkillEvidenceLedger`: a verified tool → status verified + its files; a tool only in partials → transferable + bridge; an unmatched tool → gap + empty. Tool↔skill matching via normalize (Python ↔ "Python/Bash automation").
- matcher: `evidenceFiles` present in the schema; fail-open → `[]`.

## Out of scope
- The tucaken UI panel (follow-up).
- Re-running retrieval per tool (we reuse the matcher's single retrieval + its citations).
