# Round-Type Extension + Coach Awareness (S5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add `troubleshooting | architecture-review | hands-on-lab` to `round_type` end-to-end, make Coach prep round-appropriate, seed cited companies where documented.

**Architecture:** Extend the `round_type` union in all 3 type-sites (shared enum, admin-api validation, UI type); add per-round-type Coach guidance to the constraint block; migration 061 backfills only documented (cited) companies. round_type stays a company-format fact, separate from S2's pillar.

**Tech Stack:** TypeScript, Jest, PostgreSQL. **Spec:** `docs/superpowers/specs/2026-06-02-round-type-s5-design.md`. **Branches:** PR1 `feat/round-type-s5` (ai-applications, off develop). PR2 off tucaken `main`.

---

## Task 1: shared enum + coach guidance (ai-applications)

**Files:** Modify `applications/shared/src/stage-prep/stage-prep-types.ts`; `applications/shared/src/stage-prep/constraint-block.ts`; Test `applications/shared/src/stage-prep/constraint-block.test.ts`.

- [ ] **Step 1:** Extend `ProcessStage.round_type` (stage-prep-types.ts:36) — append `| 'troubleshooting' | 'architecture-review' | 'hands-on-lab'`.
- [ ] **Step 2: Write failing test** in constraint-block.test.ts:

```typescript
import { buildStagePrepConstraintBlock } from './constraint-block.js';
const block = (roundType: string) => buildStagePrepConstraintBlock({
  expectation: null, processShape: [], comp: null, gapTemplates: [], compTarget: null, roundType,
} as any);

it('emits architecture-review guidance', () => {
  const b = block('architecture-review');
  expect(b).toMatch(/This interview round's type: architecture-review/);
  expect(b).toMatch(/walk a system you built/i);
});
it('emits troubleshooting guidance', () => expect(block('troubleshooting')).toMatch(/incident-style debugging|log\/metric/i));
it('emits hands-on-lab guidance', () => expect(block('hands-on-lab')).toMatch(/time-boxed hands-on/i));
it('emits NO extra guidance line for an existing type (dsa)', () => {
  const b = block('dsa');
  expect(b).toMatch(/This interview round's type: dsa/);
  expect(b).not.toMatch(/walk a system you built|incident-style|time-boxed hands-on/i);
});
```
(Adapt the `StagePrepConstraints` literal to the real shape — read the interface first.)

- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4: Implement** in constraint-block.ts — add the map near the top:

```typescript
const ROUND_TYPE_GUIDANCE: Record<string, string> = {
  'architecture-review': 'For an architecture-review round, be ready to walk a system you built end-to-end: starting context, key decisions, tradeoffs, outcomes, and what you would change.',
  'troubleshooting': 'For a troubleshooting round, expect incident-style debugging: log/metric analysis, hypothesis → isolate → fix, and an on-call/postmortem narrative.',
  'hands-on-lab': 'For a hands-on-lab round, expect a time-boxed exercise (build/debug/eval); prioritise a working, tested, explainable result over cleverness.',
};
```
In `buildStagePrepConstraintBlock`, right after the existing `if (c.roundType) lines.push(\`This interview round's type: ${c.roundType}.\`);`:
```typescript
if (c.roundType && ROUND_TYPE_GUIDANCE[c.roundType]) lines.push(ROUND_TYPE_GUIDANCE[c.roundType]);
```

- [ ] **Step 5:** Run → PASS. `npm run build -w applications/shared` clean.
- [ ] **Step 6:** Commit — `feat(stage-prep): round_type +troubleshooting/architecture-review/hands-on-lab + coach guidance`

---

## Task 2: migration 061 — cited backfill (ai-applications)

**Files:** Create `applications/platform-rds-bootstrap/migrations/061_round_type_devops_ai_backfill.sql`

- [ ] **Step 1: Source check (honesty gate).** Do a quick web check (WebSearch) for companies whose PRIMARY technical interview round is documented (2024–2026) as troubleshooting / architecture-review / hands-on-lab. Rules: (a) only seed a company whose round is PREDOMINANTLY that format — do NOT narrow an existing `mixed` company (that loses info); (b) prefer ADDING a new `company_interview_profiles` row (with a cited source + confidence) over re-tagging; (c) if a type has no honest documented case, leave it unseeded and say so in the migration header comment. Capture the cited source per row.
- [ ] **Step 2: Write the migration** — `INSERT INTO company_interview_profiles (...) ... ON CONFLICT (company_key) DO UPDATE` for the cited rows, mirroring 053's shape (company_key, display_name, company_type, process_shape with the technical stage carrying the new round_type + a `note` citing the source, source, as_of). Header comment lists which types were seeded vs left unseeded (with reason). Idempotent.
- [ ] **Step 3: Apply to dev** (ephemeral psql pod). Verify the seeded rows' technical round_type ∈ the new values.
- [ ] **Step 4:** Commit — `feat(stage-prep): cited round_type backfill for documented DevOps/AI rounds (migration 061)`

---

## Task 3: admin-api + UI type extensions (tucaken-app)

**Branch:** `git checkout main && git pull --ff-only && git checkout -b feat/round-type-s5-ui`

**Files:** Modify `admin-api/src/routes/applications.ts`; `src/lib/types/applications.types.ts`; tests in `admin-api/__tests__/routes/applications.test.ts` + `src/__tests__/features/applications/stage-components.test.tsx`.

- [ ] **Step 1:** admin-api — add `'troubleshooting' | 'architecture-review' | 'hands-on-lab'` to the `TechnicalRoundType` union AND the `VALID_ROUND_TYPES` Set.
- [ ] **Step 2:** UI — add the same 3 to `ApplicationDetail.technicalRoundType`. Leave `DSA_ROUND_TYPES` unchanged.
- [ ] **Step 3: Write/extend tests:**
  - admin-api: GET /:slug returns `technicalRoundType: 'architecture-review'` when the company profile has it (no longer rewritten to `dsa`). Mirror the existing technicalRoundType test; mock the company_interview_profiles query to return `architecture-review`.
  - UI: TechnicalWorkspace with `technicalRoundType: 'troubleshooting'` → DSA section NOT rendered (mirror the existing DSA-gating test).
- [ ] **Step 4:** Run admin-api + UI suites → green. Typecheck clean.
- [ ] **Step 5:** Commit — `feat(round-type): admin-api + UI accept troubleshooting/architecture-review/hands-on-lab`

---

## Final
- [ ] `npm test -w applications/shared` (PR1) + UI/admin-api suites (PR2) green.
- [ ] Final code-reviewer (focus: all 3 type-sites consistent so admin-api no longer rewrites new values to dsa; coach guidance only for the 3 new types; DSA section hidden for them; backfill cited-only).
- [ ] PRs: PR1 base develop (migration 061 — leaves 057–060 for S3/S4 open PRs), PR2 base main. Deploy 061 before admin-api; re-analysis not needed (round_type is company data, resolved per-request).

## Out of scope
System-tour for architecture-review (S7); deriving round_type from pillar; new workspace surfaces.
