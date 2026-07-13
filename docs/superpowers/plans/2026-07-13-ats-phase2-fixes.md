# ATS Phase 2 — Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the ATS review, in the Phase-1 subsystem structure, each with a TDD test.

**Architecture:** Deterministic-logic fixes — no persona/prompt changes, so unit tests suffice (no live A/B). Paths are the POST-Phase-1 layout (`ats/matching/`, `ats/gate/`, `ats/grounding/`, `ats/reconcile/`, `ats/context/`, `ats/length/`). One cross-repo change: a numbered RLS migration in `platform-rds-bootstrap`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), ts-jest, Zod, Postgres (numbered SQL migrations with a checksum ledger).

## Global Constraints

- Branch: continue on `refactor/ats-subsystems` (Phase 2 PR stacked on Phase 1), or a stacked branch off it.
- TDD: write the failing test first, watch it fail for the right reason, then fix.
- Run ESLint on changed files + `yarn workspace @bedrock/job-strategist exec tsc --noEmit`; keep the full suite green.
- English (UK), ASCII only. No `Co-Authored-By` trailer.
- CLAUDE.md: Sonnet for narrative generation (§4); RLS context set in-txn via `SELECT set_config('app.current_user_id', $1, true)`; numbered migrations use the checksum ledger and must reject changed historical migrations.
- Regression fixtures REQUIRED: `'AI Engineering'` must NOT match `'Data Engineering Pipelines'` (F1); `'project management'` with the two words in unrelated sentences must be false (F4).

---

## Group 1 — matching/ precision (fixes auto-propagate to both tiers)

### Task 1: F1 [Critical] — `tokenOverlapMatch` generic-word false-verified

**Files:**
- Modify: `ats/matching/keyword-match.ts` (`tokenOverlapMatch`, ~L72-80)
- Test: `ats/matching/keyword-match.test.ts`

**Interfaces:** Consumes/Produces `tokenOverlapMatch(a: string, b: string, minShared = 2): boolean` — signature unchanged.

- [ ] **Step 1: Failing test**
```typescript
import { tokenOverlapMatch } from './keyword-match.js';

describe('tokenOverlapMatch — generic-word reduction guard (F1)', () => {
    it('does NOT match when a multi-word term collapses to a single generic token', () => {
        // "AI Engineering" -> {engineering} after the <3-char "ai" is dropped;
        // must NOT then match any string containing "engineering".
        expect(tokenOverlapMatch('AI Engineering', 'Data Engineering Pipelines')).toBe(false);
        expect(tokenOverlapMatch('ML Ops', 'Cloud Ops team')).toBe(false);
    });
    it('still matches a genuine multi-token overlap', () => {
        expect(tokenOverlapMatch('root cause analysis', 'performed root-cause analysis on incidents')).toBe(true);
    });
});
```
- [ ] **Step 2: Run — expect the first case to FAIL** (`Received: true`): `yarn workspace @bedrock/job-strategist test -- keyword-match`
- [ ] **Step 3: Fix.** In `tokenOverlapMatch`, after computing the significant-token sets for `a` and `b`, guard the single-token case: when the SMALLER significant-token set has size 1, require an EXACT token match against the other set (not the ≥60%-of-smaller-set ratio, which makes one generic word match anything). Concretely: the ≥60% ratio branch must only apply when the smaller set has ≥2 tokens; a 1-token term matches only if that token equals a token in the other set AND the term's ORIGINAL (pre-filter) form had no additional discriminating word dropped — i.e. do not credit a match when the discriminating token (`ai`, `ml`, `ux`) was filtered out. Simplest robust rule: if either side reduces to a single significant token that is a common domain word (engineering, development, management, operations, analysis, design, support), require the FULL normalized phrase (all original tokens incl. the short ones) to appear. Read the current body and apply the minimal change that makes Step-1 green without breaking Step-3's true positive.
- [ ] **Step 4: Run — all green.** Also run the ledger test that consumes this (`grounding/skill-evidence-ledger.test.ts`) to confirm no regression.
- [ ] **Step 5: Commit** `fix(ats): tokenOverlapMatch no longer credits a generic-word single-token reduction (F1)`

### Task 2: F4 [Important] — `matchTier1` AND-without-proximity

**Files:**
- Modify: `ats/matching/keyword-match.ts` (`matchTier1`, ~L47-59)
- Test: `ats/matching/keyword-match.test.ts`

**Interfaces:** `matchTier1(term: string, resumeLowerText: string): boolean` — unchanged.

- [ ] **Step 1: Failing test**
```typescript
import { matchTier1 } from './keyword-match.js';

describe('matchTier1 — proximity for multi-word terms (F4)', () => {
    it('does NOT match when tokens appear in unrelated sentences', () => {
        expect(matchTier1('project management',
            'Shipped a side project last year. Handled stakeholder time management separately.')).toBe(false);
    });
    it('DOES match when the tokens co-occur as the actual phrase/skill', () => {
        expect(matchTier1('project management', 'led project management for a 6-person team')).toBe(true);
        expect(matchTier1('aws', 'deployed on aws')).toBe(true); // single-token unaffected
    });
});
```
- [ ] **Step 2: Run — first case FAILS** (currently `true`).
- [ ] **Step 3: Fix.** For a normalized term with ≥2 significant tokens, replace the "every token appears anywhere" check with a proximity/co-occurrence check: the tokens must appear within a bounded window (e.g. same sentence, or within N=8 words) OR the full normalized phrase appears as a substring. Single-token terms keep today's substring behaviour. Read the current `matchTier1` and implement the window check minimally.
- [ ] **Step 4: Run — green;** run `coverage/attainable.test.ts` + `grounding/skill-evidence-ledger.test.ts` (both consume `matchTier1`) — no regression.
- [ ] **Step 5: Commit** `fix(ats): matchTier1 requires proximity for multi-word terms (F4)`

---

## Group 2 — grounding/ number + provenance

### Task 3: F2 [High] — number allowed-set from verbatim evidence only

**Files:**
- Modify: `run-pipeline.ts` (the two sites building the number `allowed` set / grounding facts, ~L1135 and ~L1260)
- Test: `run-pipeline`-adjacent unit or a focused test on the helper that builds the allowed set (extract a small pure helper if the logic is inline, so it is unit-testable).

**Interfaces:** Produces (if extracted) `buildAllowedNumbers(research: StrategistResearchResult): Set<number>` sourcing ONLY verbatim fields.

- [ ] **Step 1: Failing test** — a research object whose `verifiedMatches[].sourceCitation` contains "cut deploy time 40%" but whose `quantifiedEvidence` does NOT contain 40; assert 40 is NOT in the allowed set.
```typescript
it('does not admit a number that appears only in free-text sourceCitation (F2)', () => {
    const research = { verifiedMatches: [{ skill: 'X', sourceCitation: 'cut deploy time 40% (paraphrase)' }],
        quantifiedEvidence: ['deployed to 3 regions'], partialMatches: [], gaps: [] } as any;
    const allowed = buildAllowedNumbers(research);
    expect(allowed.has(40)).toBe(false);
    expect(allowed.has(3)).toBe(true);
});
```
- [ ] **Step 2: Run — FAILS** (40 currently admitted via sourceCitation).
- [ ] **Step 3: Fix.** Extract `buildAllowedNumbers` (if inline) and seed it from VERBATIM sources only — `quantifiedEvidence` (instructed verbatim from KB) + the candidate's grounded facts blocks — and STOP folding `verifiedMatches.map(m => m.sourceCitation)` prose into it. Update both call sites (~L1135, ~L1260) to use the helper. Keep `extractNumbers` for parsing.
- [ ] **Step 4: Run — green;** run `grounding/number-provenance.test.ts` — no regression.
- [ ] **Step 5: Commit** `fix(ats): number allowed-set uses verbatim evidence, not paraphrased citations (F2)`

### Task 4: F3 [High] — re-strip instruction metrics after every rewrite

**Files:**
- Modify: `run-pipeline.ts` (after `applyLengthBudget` and after `surfaceKeywords`) and/or `ats/length/length-budget.ts` (call `stripInstructionMetrics` inside `condenseResume`/`expandResume` on their own output)
- Test: `ats/grounding/number-provenance.test.ts` (already the home of instruction-leak tests)

**Interfaces:** `stripInstructionMetrics(resume, instructionNumbers)` — existing signature.

- [ ] **Step 1: Failing test** — feed a resume containing a number that equals a length-budget instruction value (e.g. 32 from `perBulletWords: 32`) introduced post-condense, with 32 NOT in the grounded set; assert it is stripped after the budget stage.
- [ ] **Step 2: Run — FAILS** (only `stripUngroundedNumbers` runs post-budget today).
- [ ] **Step 3: Fix.** Re-run `stripInstructionMetrics` (with the instruction-number set that includes the length-budget + surface-keyword prompt constants) after `applyLengthBudget` (~L1184) and after `surfaceKeywords`. Centralise the instruction-number constant set so condense/expand/surface-keywords budgets are covered.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `fix(ats): re-strip instruction-metric numbers after condense/expand/surface-keywords (F3)`

### Task 5: grounding Med/Low — negation guard, short canonicals, fail-open telemetry, padded/canon dedup

**Files:**
- Modify: `ats/grounding/ledger-provenance.ts` (negation guard + short-canonical filter), `ats/grounding/{vendor-provenance,code-truth}.ts` (telemetry), `ats/grounding/{vendor-provenance,code-truth,tool-evidence-retrieval,evidence-lane}.ts` (import `padded`/`canon` from `ats/matching/` instead of local copies)
- Tests: the corresponding `*.test.ts`

- [ ] **Step 1: Failing tests** — (a) `attachPassageProvenance` must NOT attach a passage containing "migrated away from Kubernetes" / "no longer use X" as supporting for that skill; (b) a short canonical (`SQL`) with strong KB evidence DOES get a passage; (c) `padded` imported from matching produces identical output (a re-export smoke test).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Fix.** (a) In `ledger-provenance.ts`, before attaching, reject a passage whose token-hit sits inside a negation/migration context (`/\b(migrated away from|no longer|deprecated|replaced|moved off)\b/i` within a small window of the tool token). (b) Lower/adjust `toolTokens` so known short canonicals (allowlist: SQL, Go, AWS, EKS, IAM, CDK, GCP, CI, CD) are not dropped by the <4-char filter. (c) Add a one-line `log.warn` (or a metric label) in `demoteMisattributedVendors`/`demoteCodeContradictedMatches` distinguishing "ran, 0 demotions" from "deps empty (ontology load failed)". (d) Delete the local `padded()` copies; import from `ats/matching/keyword-match.js`.
- [ ] **Step 4: Run — green** across grounding tests.
- [ ] **Step 5: Commit** `fix(ats): provenance negation guard + short canonicals + fail-open telemetry + padded dedup`

---

## Group 3 — gate/ pass-signal, persistence, gate hygiene

### Task 6: F5 + F6 [Important] — reconcile the pass signals + persist attainable fields to ats_check_json

**Files:**
- Modify: `ats/gate/checks.ts` (headline `passed`), `ats/gate/ats-check.schema.ts` (add attainable fields), `ats/gate/run-ats-check.ts` + `run-pipeline.ts` (persist the merged object to `ats_check_json`, not only metadata)
- Test: `ats/gate/checks.test.ts`, `ats/gate/run-ats-check.test.ts`

**Interfaces:** `AtsCheckResult` gains optional `attainableTotal/attainableCovered/attainablePassed/surfacedKeywords`; headline `passed = (status === 'passed') && (attainablePassed !== false)`.

- [ ] **Step 1: Failing tests** — (a) a result with `status:'issues'` and `attainablePassed:true` yields headline `passed === false`; a result with `status:'passed'` and `attainablePassed:false` yields `passed === false`; `status:'passed'` + `attainablePassed:true` (or undefined) → `passed === true`. (b) after `renderCheckAndStoreAts` + the attainable merge, the object persisted to `ats_check_json` INCLUDES `attainablePassed`.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Fix.** Add the attainable fields to `AtsCheckResultSchema`. Compute the headline `passed` per the rule. Move the attainable-field merge so it happens BEFORE the `storeAtsArtifacts` write (or re-store after the merge) so `resumes.ats_check_json` carries them, not just `pipeline_runs.metadata`. Emit ONE reconciled Prometheus outcome.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `fix(ats): reconcile headline pass-signal + persist attainable fields to ats_check_json (F5,F6)`

### Task 7: F8 + coverage minors — recovery UPDATE row-count, schema safeParse, name/email whitespace, parallel embeddings

**Files:**
- Modify: `ats/gate/run-ats-check.ts` (recovery UPDATE row-count + log; parallelise the per-term embedding tier; `safeParse` at the store boundary), `ats/gate/checks.ts` (whitespace-normalise name/email presence)
- Test: `ats/gate/run-ats-check.test.ts`, `ats/gate/checks.test.ts`

- [ ] **Step 1: Failing tests** — (a) the catch-path recovery UPDATE, when it matches 0 rows, logs a warning (spy) rather than silently swallowing; (b) `buildAtsCheck` reports name found when the extracted text has a collapsed double-space / line-wrap in the name; (c) an invalid `AtsCheckResult` shape is caught by `safeParse` at store and logged.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Fix.** (a) In the `renderCheckAndStoreAts` catch, check `rowCount` and `log.warn` on 0 (mirror `storeAtsArtifacts`). (b) In `checks.ts`, normalise whitespace (`replace(/\s+/g,' ')`) on both the extracted text and the name/email before `includes`. (c) `safeParse` the result before `storeAtsArtifacts` writes it; on failure log and proceed with the object (don't throw — stay fail-open). (d) Replace the serial `for (const term of mustHaves) await matchTerm(...)` with `Promise.all(mustHaves.map(matchTerm...))`.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `fix(ats): recovery-UPDATE row-count + schema safeParse + name/email whitespace + parallel embeddings (F8)`

---

## Group 4 — length/

### Task 8: F7 [Important] + Haiku→Sonnet

**Files:**
- Modify: `ats/length/length-budget.ts` (`hardTrimExperience` per-bullet word trim; condense/expand model default → Sonnet)
- Test: `ats/length/length-budget.test.ts`

**Interfaces:** `hardTrim(resume)` unchanged signature; now also trims over-long individual bullets.

- [ ] **Step 1: Failing test** — a resume with ≤5 experience bullets where ONE bullet exceeds `perBulletWords` (e.g. 91 words); after `hardTrim`, that bullet is ≤ `perBulletWords` and the resume is no longer over the experience budget.
- [ ] **Step 2: Run — FAILS** (today `hardTrimExperience` only caps bullet count).
- [ ] **Step 3: Fix.** Add a per-bullet word trim to `hardTrimExperience` (reuse `trimSentences`/word-slice like `hardTrimProjects`), applied after the count cap. Change the condense/expand model default from the Haiku id to `eu.anthropic.claude-sonnet-4-6` (keep the env override).
- [ ] **Step 4: Run — green** (existing length tests + the new one).
- [ ] **Step 5: Commit** `fix(ats): per-bullet hard-trim backstop + Sonnet for condense/expand (F7, §4)`

---

## Group 5 — reconcile/

### Task 9: F9 [Important] — education-reconcile regex overmatch (2 bugs)

**Files:**
- Modify: `ats/reconcile/education-reconcile.ts` (`DEGREE_REQ_RE` ~L20, `TECHNICAL_FIELD_RE` ~L23)
- Test: `ats/reconcile/education-reconcile.test.ts`

- [ ] **Step 1: Failing tests** — (a) a requirement context "a high degree of ownership" must NOT be detected as a degree requirement; (b) a Political Science / Mechanical Engineering degree must NOT satisfy a CS/software degree requirement (no false VERIFIED).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Fix.** Tighten `DEGREE_REQ_RE` so bare `degree` only matches in a credential context ("degree in", "bachelor/master/BSc/MSc ... degree"), not "degree of". Tighten `TECHNICAL_FIELD_RE` so bare `engineer`/`science` require a computing qualifier (computer/software/CS/IT/electrical-adjacent per the domain), not any Science/Engineering field.
- [ ] **Step 4: Run — green** (existing happy-path tests + the two new negatives).
- [ ] **Step 5: Commit** `fix(ats): education-reconcile no longer overmatches "degree of" / unrelated Science/Engineering (F9)`

### Task 10: F10 + F11 [Important] — migration-reframe scans projects; shared peer-predecessor guard

**Files:**
- Modify: `ats/reconcile/migration-reframe.ts` (`proseSurfaces` ~L126 add projects), extract the peer-predecessor-still-current guard into a shared helper; `ats/grounding/code-truth.ts` (consume the shared guard, ~L108)
- New: `ats/matching/` or `ats/reconcile/` shared helper `peerPredecessorStillCurrent(...)` (place where both can import; if it needs succeedsEdges + codeTech, a small `ats/context/` or `ats/grounding/` util is fine — pick the one with no circular import)
- Test: `ats/reconcile/migration-reframe.test.ts`, `ats/grounding/code-truth.test.ts`

- [ ] **Step 1: Failing tests** — (a) `detectStaleMigrations` finds a stale predecessor claim inside `projects[].highlights` / `.description`; (b) `demoteCodeContradictedMatches` does NOT demote a verified match when the predecessor tech is itself still current per the peer check (the case migration-reframe already guards but code-truth does not).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Fix.** Add `projects[].highlights` + `.description` to `proseSurfaces`. Extract the peer-predecessor guard (currently in `migration-reframe.ts:73-87`) into one shared function; call it from both `migration-reframe` and `code-truth`'s demotion decision.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `fix(ats): migration-reframe scans projects + shared peer-predecessor guard for code-truth (F10,F11)`

---

## Group 6 — context/ + RLS migration

### Task 11: resolveCanonical shared helper (canonicalisation divergence)

**Files:**
- Modify: `ats/context/retrieval-prefilter.ts` + `ats/context/tech-transfer-context.ts` to import ONE `resolveCanonical(term, aliasMap)` (place in `ats/matching/keyword-match.ts` alongside the other primitives, or `ats/context/`); remove the divergent inline normalisation
- Test: a shared test asserting `Node.js` (no alias hit) resolves identically in both call paths

- [ ] **Step 1: Failing test** — assert both modules resolve a punctuation-bearing term (`Node.js`) to the same canonical.
- [ ] **Step 2: Run — fail** (divergent fallback today).
- [ ] **Step 3: Fix.** Add `resolveCanonical` (alias-map hit → canonical; else `normalizeTerm`), use it in both files.
- [ ] **Step 4: Run — green.**
- [ ] **Step 5: Commit** `fix(ats): shared resolveCanonical removes prefilter/tech-transfer divergence`

### Task 12: F12 [Important] — repo_profile RLS migration (cross-repo)

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/<NNN>_repo_profile_rls.sql` (next free number — check the directory)
- Verify: apply to dev via the migration runner; confirm RLS blocks cross-user reads and the `job_strategist` (or the app) role retains its grant.

- [ ] **Step 1: Find the next migration number** — `ls applications/platform-rds-bootstrap/migrations/ | sort | tail -5`. Use the next integer, no gaps.
- [ ] **Step 2: Write the migration (idempotent).** For `repo_profile` and the sibling provenance tables written by `persistRepoProfiles`/`persistEvidenceProvenance`/`persistRepoEvidenceQuality`:
```sql
-- <NNN>_repo_profile_rls.sql — add RLS to repo_profile + sibling provenance tables
ALTER TABLE repo_profile ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repo_profile_user_isolation ON repo_profile;
CREATE POLICY repo_profile_user_isolation ON repo_profile
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
-- repeat ENABLE + DROP/CREATE POLICY for each sibling provenance table with a user_id column
```
Match the exact policy shape used by the ~23 other RLS tables in the migration set (read one for the canonical form, incl. any FORCE ROW LEVEL SECURITY + role grants the codebase standardises on).
- [ ] **Step 3: Apply to dev + verify.** Run the numbered-migration runner against dev; then verify: a `set_config('app.current_user_id', <userA>)` session cannot SELECT userB's `repo_profile` rows, and the app role can still INSERT under its own id. Record the verification in the task report.
- [ ] **Step 4: Confirm the checksum ledger accepts the new (appended) migration and rejects no historical one.**
- [ ] **Step 5: Commit** `feat(rds): RLS on repo_profile + sibling provenance tables (F12)`

---

## Group 7 — hygiene

### Task 13: grounded-coverage tabs→spaces + AtsCheckResultSchema already made live in Task 6

**Files:** Modify `ats/gate/grounded-coverage.ts` (reindent tabs→spaces to match the codebase).
- [ ] **Step 1:** Reindent; run `npx eslint ats/gate/grounded-coverage.ts` — clean.
- [ ] **Step 2: Full suite green;** commit `style(ats): grounded-coverage tabs to spaces`.

---

## Self-Review

**Spec coverage:** F1→T1, F4→T2, F2→T3, F3→T4, grounding Med/Low+dedup→T5, F5+F6→T6, F8+coverage minors→T7, F7+Sonnet→T8, F9→T9, F10+F11→T10, resolveCanonical→T11, F12→T12, tabs→T13. AtsCheckResultSchema made live in T6/T7 (safeParse). All findings mapped. ✓

**Placeholder scan:** each task has a concrete failing test + a specific fix instruction against a named function/line. The fix bodies reference the actual functions (implementer reads current code) rather than inventing a full rewrite — legitimate for TDD where the test pins behaviour. The RLS SQL is real. No "TBD"/"handle edge cases".

**Type consistency:** `buildAllowedNumbers` (T3) reused by T4's instruction set; the `AtsCheckResult` attainable fields (T6) are what T7's persistence/`safeParse` validate; `resolveCanonical` (T11) and the shared peer-predecessor guard (T10) are each defined once and imported.

## Execution Handoff
Phase 2 PR, stacked on Phase 1. After both merge + deploy, the user triggers Phase 3 (summary ↔ ATS wiring), which is a separate spec/plan.
