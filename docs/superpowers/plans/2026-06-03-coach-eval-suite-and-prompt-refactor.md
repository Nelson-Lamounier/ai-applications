# Coach Eval Suite + Prompt Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-stage eval suite (Tier 1 deterministic graders + Tier 2 live/judge scaffold) for the Interview Coach, then refactor the fat persona prompt into base + per-stage Skills-pattern folders keyed on the canonical stage enum.

**Architecture:** Tier 1 graders are pure functions over `(EvalInput, InterviewCoachResult)` asserting properties (schema, grounding, stage-focus, honesty), run in jest every commit against hand-authored synthetic fixtures. Tier 2 is a gated live runner + LLM-judge scaffold. The eval suite is built first and acts as the regression harness for the prompt refactor, which hard-cuts `COACH_PERSONA_SYSTEM_PROMPT` (no shim).

**Tech Stack:** TypeScript (ESM, `.js` import extensions), jest (`applications/job-strategist`), Zod, `@bedrock/shared` (re-exports `validateSkillTransfer`, `SkillCandidateSet`, `SkillTransferEntry`, `InterviewStage`, `InterviewCoachResult` via `stage-prep/index.js`).

**Spec:** `docs/superpowers/specs/2026-06-03-coach-eval-suite-and-prompt-refactor-design.md`

---

## File Structure

**Eval suite (item A):**
- `src/evals/graders.ts` — `EvalInput`, `GraderResult`, `GraderReport`, `Grader` types; `allowedIds`/`allowedProjectIds` shared helpers; `runGraders`.
- `src/evals/graders/schema-grader.ts` — parses vs `CoachOutputSchema` + stage required/forbidden fields.
- `src/evals/graders/grounding-grader.ts` — evidenceRef.id & projectId ∈ candidate ids; one entry per JD skill; no invented ids.
- `src/evals/graders/stage-focus-grader.ts` — branch-appropriate content (heuristic).
- `src/evals/graders/honesty-grader.ts` — `validateSkillTransfer` equality tripwire.
- `src/evals/fixtures/{phone-screen,technical,behavioural}.json` — `{ input, output }` synthetic gold cases.
- `src/evals/coach-evals.test.ts` — Tier 1: load fixtures, run all graders, assert pass.
- `src/evals/live/judge.ts` — LLM-judge prompt builder + verdict schema + report formatter.
- `src/evals/live/run-live-evals.ts` — Tier 2 runner, gated by `RUN_LIVE_EVALS=1`.
- `src/evals/live/capture-fixture.ts` — one-time real-run capture (deferred use).
- `src/evals/live/judge.test.ts` — unit tests for prompt builder + formatter (no live calls).

**Prompt refactor (item B):**
- `src/prompts/coach/base.ts` — `COACH_BASE` (role, truthfulness mandate, output-contract prose, ESL). Sole shared source. No stale JSON example.
- `src/prompts/coach/stages/phone-screen.ts` — `PHONE_SCREEN_DELTA`.
- `src/prompts/coach/stages/technical.ts` — `TECHNICAL_DELTA` (skill-transfer block).
- `src/prompts/coach/stages/behavioural.ts` — `BEHAVIOURAL_DELTA`.
- `src/prompts/coach/stages/index.ts` — `CoachBranch`, `resolveCoachBranch`, `assembleCoachSystemPrompt`.
- `src/prompts/coach/index.test.ts` — assembly + resolver unit tests.
- Modify `src/agents/coach-agent.ts` — export `CoachOutputSchema` + `PHONE_SCREEN_FIELDS`; `getConfig` uses `assembleCoachSystemPrompt`.
- Delete `src/prompts/coach-persona.ts` + `src/prompts/coach-persona.test.ts`.

**Test command (run from `applications/job-strategist`):** `npx jest <path>` for one file; `npm test` for all.

---

## Task 1: Grader core types + helpers

**Files:**
- Create: `applications/job-strategist/src/evals/graders.ts`
- Test: `applications/job-strategist/src/evals/graders.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { allowedIds, allowedProjectIds, runGraders } from './graders.js';
import type { Grader, EvalInput } from './graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'Kubernetes', candidates: [
        { projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' },
    ] },
    { jdSkill: 'Kafka', candidates: [] },
];

const INPUT: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };
const OUTPUT = {} as InterviewCoachResult;

describe('graders core', () => {
    it('allowedIds collects every candidate id', () => {
        expect(allowedIds(SETS)).toEqual(new Set(['c1']));
    });
    it('allowedProjectIds collects every candidate projectId', () => {
        expect(allowedProjectIds(SETS)).toEqual(new Set(['p1']));
    });
    it('runGraders aggregates pass=false when any grader fails', () => {
        const ok: Grader = () => ({ grader: 'ok', pass: true, score: 1, failures: [] });
        const bad: Grader = () => ({ grader: 'bad', pass: false, score: 0, failures: ['x'] });
        const report = runGraders([ok, bad], INPUT, OUTPUT);
        expect(report.pass).toBe(false);
        expect(report.results).toHaveLength(2);
    });
    it('runGraders pass=true when all pass', () => {
        const ok: Grader = () => ({ grader: 'ok', pass: true, score: 1, failures: [] });
        expect(runGraders([ok], INPUT, OUTPUT).pass).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/evals/graders.test.ts`
Expected: FAIL — `Cannot find module './graders.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/** @format */
import type { InterviewCoachResult, SkillCandidateSet, InterviewStage } from '@bedrock/shared';

/** The exact input the coach receives, frozen for grading. */
export interface EvalInput {
    analysisXml: string;
    candidateSets: SkillCandidateSet[];
    stage: InterviewStage;
}

export interface GraderResult {
    grader: string;
    pass: boolean;
    score: number; // 0..1
    failures: string[];
}

export interface GraderReport {
    pass: boolean;
    results: GraderResult[];
}

export type Grader = (input: EvalInput, output: InterviewCoachResult) => GraderResult;

/** Build a GraderResult from a name + failures list. score = pass ? 1 : 0. */
export function mkResult(grader: string, failures: string[]): GraderResult {
    return { grader, pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, failures };
}

/** All candidate evidence ids across the sets (shared by grounding + honesty graders). */
export function allowedIds(sets: readonly SkillCandidateSet[]): Set<string> {
    const s = new Set<string>();
    for (const set of sets) for (const c of set.candidates) s.add(c.id);
    return s;
}

/** All candidate projectIds across the sets. */
export function allowedProjectIds(sets: readonly SkillCandidateSet[]): Set<string> {
    const s = new Set<string>();
    for (const set of sets) for (const c of set.candidates) s.add(c.projectId);
    return s;
}

export function runGraders(graders: Grader[], input: EvalInput, output: InterviewCoachResult): GraderReport {
    const results = graders.map(g => g(input, output));
    return { pass: results.every(r => r.pass), results };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/evals/graders.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/evals/graders.ts applications/job-strategist/src/evals/graders.test.ts
git commit -m "test(job-strategist): coach eval grader core types + helpers"
```

---

## Task 2: Export CoachOutputSchema + PHONE_SCREEN_FIELDS, build schema-grader

**Files:**
- Modify: `applications/job-strategist/src/agents/coach-agent.ts` (export two symbols)
- Create: `applications/job-strategist/src/evals/graders/schema-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/schema-grader.test.ts`

- [ ] **Step 1: Export the schema + fields from coach-agent.ts**

In `coach-agent.ts`, change the `CoachOutputSchema` declaration from `const CoachOutputSchema = z.object({` to:

```typescript
export const CoachOutputSchema = z.object({
```

And change `const PHONE_SCREEN_FIELDS = [...] as const;` to:

```typescript
export const PHONE_SCREEN_FIELDS = ['careerArcSummary', 'jdTalkingPoints', 'compScript'] as const;
```

- [ ] **Step 2: Write the failing test**

```typescript
/** @format */
import { schemaGrader } from './schema-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const BASE = {
    stage: 'technical-1',
    stageDescription: 'd',
    technicalQuestions: [], behaviouralQuestions: [], difficultQuestions: [],
    technicalPrepChecklist: [], questionsToAsk: [], coachingNotes: 'n',
} as unknown as InterviewCoachResult;

const tech: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'technical-1' };
const phone: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };

describe('schemaGrader', () => {
    it('passes a valid non-phone payload', () => {
        expect(schemaGrader(tech, BASE).pass).toBe(true);
    });
    it('fails when a required field is missing', () => {
        const bad = { ...BASE, coachingNotes: undefined } as unknown as InterviewCoachResult;
        expect(schemaGrader(tech, bad).pass).toBe(false);
    });
    it('fails phone-screen missing the required phone fields', () => {
        const r = schemaGrader(phone, BASE);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('careerArcSummary');
    });
    it('fails non-phone stage that includes phone-only fields', () => {
        const withPhone = { ...BASE, careerArcSummary: 'arc' } as unknown as InterviewCoachResult;
        const r = schemaGrader(tech, withPhone);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('omit');
    });
    it('passes a valid phone-screen payload with all three fields', () => {
        const ok = {
            ...BASE, stage: 'phone-screen',
            careerArcSummary: 'arc',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
        } as unknown as InterviewCoachResult;
        expect(schemaGrader(phone, ok).pass).toBe(true);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/evals/graders/schema-grader.test.ts`
Expected: FAIL — `Cannot find module './schema-grader.js'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
/** @format */
import { CoachOutputSchema, PHONE_SCREEN_FIELDS } from '../../agents/coach-agent.js';
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';

/**
 * Asserts the output parses against the production CoachOutputSchema (reused, not
 * redefined — drift between tool schema and Zod fails here) and that the
 * phone-screen-only fields are present for phone-screen and absent otherwise.
 */
export const schemaGrader: Grader = (input, output) => {
    const failures: string[] = [];

    // `stage` is injected from context, not part of CoachOutputSchema (which is strict).
    const rec = output as unknown as Record<string, unknown>;
    const { stage: _stage, ...rest } = rec;
    const parsed = CoachOutputSchema.safeParse(rest);
    if (!parsed.success) failures.push(`schema: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

    const isPhone = input.stage === 'phone-screen';
    for (const f of PHONE_SCREEN_FIELDS) {
        const present = rest[f] !== undefined;
        if (isPhone && !present) failures.push(`phone-screen missing required field: ${f}`);
        if (!isPhone && present) failures.push(`non-phone-screen must omit field: ${f}`);
    }

    return mkResult('schema', failures);
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/evals/graders/schema-grader.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Verify the export change did not break existing coach tests**

Run: `npx jest src/agents/coach-agent.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 7: Commit**

```bash
git add applications/job-strategist/src/agents/coach-agent.ts applications/job-strategist/src/evals/graders/schema-grader.ts applications/job-strategist/src/evals/graders/schema-grader.test.ts
git commit -m "feat(job-strategist): coach schema-grader + export CoachOutputSchema"
```

---

## Task 3: grounding-grader

**Files:**
- Create: `applications/job-strategist/src/evals/graders/grounding-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/grounding-grader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { groundingGrader } from './grounding-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'Kubernetes', candidates: [
        { projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' },
    ] },
    { jdSkill: 'Kafka', candidates: [] },
];
const input: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };

function withTransfer(skillTransfer: unknown): InterviewCoachResult {
    return { skillTransfer } as unknown as InterviewCoachResult;
}

describe('groundingGrader', () => {
    it('passes when every id and projectId is a real candidate and all skills covered', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'gap' },
        ]);
        expect(groundingGrader(input, out).pass).toBe(true);
    });
    it('fails on an invented evidenceRef id', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'g' },
        ]);
        const r = groundingGrader(input, out);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('GHOST');
    });
    it('fails when a JD skill in the block has no entry', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
        ]);
        const r = groundingGrader(input, out);
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('Kafka');
    });
    it('fails on an invented projectId', () => {
        const out = withTransfer([
            { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'pX', projectName: 'AI Apps',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
            { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'g' },
        ]);
        expect(groundingGrader(input, out).pass).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/evals/graders/grounding-grader.test.ts`
Expected: FAIL — `Cannot find module './grounding-grader.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/** @format */
import { mkResult, allowedIds, allowedProjectIds } from '../graders.js';
import type { Grader } from '../graders.js';
import type { SkillTransferEntry } from '@bedrock/shared';

/**
 * Core grounding axis. Every emitted citation must trace to a real candidate id
 * surfaced in the candidate block, and every JD skill in the block must have an
 * entry. Invented ids/projectIds are the failure this guards against.
 */
export const groundingGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const ids = allowedIds(input.candidateSets);
    const projIds = allowedProjectIds(input.candidateSets);
    const skillsInBlock = new Set(input.candidateSets.map(s => s.jdSkill));
    const entries = (output.skillTransfer ?? []) as SkillTransferEntry[];

    const covered = new Set(entries.map(e => e.jdSkill));
    for (const skill of skillsInBlock) {
        if (!covered.has(skill)) failures.push(`no skillTransfer entry for JD skill: ${skill}`);
    }

    for (const e of entries) {
        if (e.tier === 'gap') continue; // gap shape checked by honesty-grader
        if (e.projectId != null && !projIds.has(e.projectId)) {
            failures.push(`invented projectId "${e.projectId}" for ${e.jdSkill}`);
        }
        for (const r of e.evidenceRefs) {
            if (!ids.has(r.id)) failures.push(`invented evidenceRef id "${r.id}" for ${e.jdSkill}`);
        }
    }

    return mkResult('grounding', failures);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/evals/graders/grounding-grader.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/evals/graders/grounding-grader.ts applications/job-strategist/src/evals/graders/grounding-grader.test.ts
git commit -m "feat(job-strategist): coach grounding-grader (no invented citations)"
```

---

## Task 4: stage-focus-grader

**Files:**
- Create: `applications/job-strategist/src/evals/graders/stage-focus-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/stage-focus-grader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { stageFocusGrader } from './stage-focus-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const withCands: SkillCandidateSet[] = [
    { jdSkill: 'K8s', candidates: [{ projectId: 'p1', projectName: 'A', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
];

describe('stageFocusGrader', () => {
    it('phone-screen passes with comp/career/talking points populated', () => {
        const out = {
            careerArcSummary: 'arc',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
            behaviouralQuestions: [],
        } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };
        expect(stageFocusGrader(input, out).pass).toBe(true);
    });
    it('phone-screen fails with empty jdTalkingPoints', () => {
        const out = { careerArcSummary: 'arc', jdTalkingPoints: [], compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' } } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'phone-screen' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
    it('technical fails when candidates exist but skillTransfer is empty', () => {
        const out = { skillTransfer: [], behaviouralQuestions: [] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: withCands, stage: 'technical-1' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
    it('behavioural fails with no behaviouralQuestions', () => {
        const out = { behaviouralQuestions: [] } as unknown as InterviewCoachResult;
        const input: EvalInput = { analysisXml: '<x/>', candidateSets: [], stage: 'behavioural' };
        expect(stageFocusGrader(input, out).pass).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/evals/graders/stage-focus-grader.test.ts`
Expected: FAIL — `Cannot find module './stage-focus-grader.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';

/**
 * Heuristic branch-focus check (field presence only — deep judgment is Tier 2's
 * job). Keyed directly on the canonical stage values so it carries no dependency
 * on the prompt-refactor resolver.
 */
export const stageFocusGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const s = input.stage;

    if (s === 'phone-screen') {
        if (!output.careerArcSummary) failures.push('phone-screen: missing careerArcSummary content');
        if (!output.compScript) failures.push('phone-screen: missing compScript');
        if (!(output.jdTalkingPoints && output.jdTalkingPoints.length > 0)) failures.push('phone-screen: empty jdTalkingPoints');
    } else if (s === 'technical-1' || s === 'technical-2') {
        const hasCandidates = input.candidateSets.some(set => set.candidates.length > 0);
        const hasTransfer = !!(output.skillTransfer && output.skillTransfer.length > 0);
        if (hasCandidates && !hasTransfer) failures.push('technical: candidates present but skillTransfer empty');
    } else if (s === 'behavioural') {
        if (!(output.behaviouralQuestions && output.behaviouralQuestions.length > 0)) failures.push('behavioural: no behaviouralQuestions');
    }

    return mkResult('stage-focus', failures);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/evals/graders/stage-focus-grader.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/evals/graders/stage-focus-grader.ts applications/job-strategist/src/evals/graders/stage-focus-grader.test.ts
git commit -m "feat(job-strategist): coach stage-focus-grader (branch field presence)"
```

---

## Task 5: honesty-grader (validateSkillTransfer tripwire)

**Files:**
- Create: `applications/job-strategist/src/evals/graders/honesty-grader.ts`
- Test: `applications/job-strategist/src/evals/graders/honesty-grader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { honestyGrader } from './honesty-grader.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult, SkillCandidateSet } from '@bedrock/shared';

const SETS: SkillCandidateSet[] = [
    { jdSkill: 'K8s', candidates: [{ projectId: 'p1', projectName: 'A', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS' }] },
];
const input: EvalInput = { analysisXml: '<x/>', candidateSets: SETS, stage: 'technical-1' };
const out = (skillTransfer: unknown) => ({ skillTransfer } as unknown as InterviewCoachResult);

describe('honestyGrader', () => {
    it('passes when entries already honest (validate is a no-op)', () => {
        const r = honestyGrader(input, out([
            { jdSkill: 'K8s', tier: 'demonstrated', projectId: 'p1', projectName: 'A',
              evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS' }], narrative: 'n' },
        ]));
        expect(r.pass).toBe(true);
    });
    it('fails when an entry would be demoted by validateSkillTransfer', () => {
        const r = honestyGrader(input, out([
            { jdSkill: 'K8s', tier: 'demonstrated', projectId: 'p1', projectName: 'A',
              evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'n' },
        ]));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toContain('demoted');
    });
    it('passes with no skillTransfer (nothing to verify)', () => {
        expect(honestyGrader(input, out(undefined)).pass).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/evals/graders/honesty-grader.test.ts`
Expected: FAIL — `Cannot find module './honesty-grader.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/** @format */
import { validateSkillTransfer } from '@bedrock/shared';
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { SkillTransferEntry } from '@bedrock/shared';

/**
 * Honesty tripwire. Runs the production validateSkillTransfer over the emitted
 * entries: on honest gold output it is a no-op, so any divergence means the model
 * invented a citation that runtime would have demoted to a gap. Known-skill entries
 * are compared by value; unknown-skill entries (which validate drops) are excluded
 * from the comparison set so the equality holds for honest output.
 */
export const honestyGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const entries = (output.skillTransfer ?? []) as SkillTransferEntry[];
    const knownSkills = new Set(input.candidateSets.map(s => s.jdSkill));
    const known = entries.filter(e => knownSkills.has(e.jdSkill));
    const validated = validateSkillTransfer(entries, input.candidateSets);

    if (JSON.stringify(validated) !== JSON.stringify(known)) {
        failures.push('skillTransfer not honest: validateSkillTransfer demoted/dropped entries');
    }

    return mkResult('honesty', failures);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/evals/graders/honesty-grader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/evals/graders/honesty-grader.ts applications/job-strategist/src/evals/graders/honesty-grader.test.ts
git commit -m "feat(job-strategist): coach honesty-grader (validateSkillTransfer tripwire)"
```

---

## Task 6: Synthetic fixtures + Tier 1 suite

**Files:**
- Create: `applications/job-strategist/src/evals/fixtures/phone-screen.json`
- Create: `applications/job-strategist/src/evals/fixtures/technical.json`
- Create: `applications/job-strategist/src/evals/fixtures/behavioural.json`
- Create: `applications/job-strategist/src/evals/coach-evals.test.ts`

- [ ] **Step 1: Write `technical.json`** (the grounding-heavy case)

```json
{
  "input": {
    "analysisXml": "<analysis><fit>STRONG</fit></analysis>",
    "stage": "technical-1",
    "candidateSets": [
      { "jdSkill": "Kubernetes", "candidates": [
        { "projectId": "p1", "projectName": "AI Applications", "source": "component", "tier": "demonstrated", "id": "c1", "label": "EKS self-healing operator" }
      ] },
      { "jdSkill": "Kafka", "candidates": [] }
    ]
  },
  "output": {
    "stage": "technical-1",
    "stageDescription": "Technical interview — coding, AWS, K8s.",
    "technicalQuestions": [
      { "question": "Walk through your K8s operator.", "answerFramework": "Concept then your EKS operator.", "sourceProject": "AI Applications", "difficulty": "medium", "keyPoints": ["controller pattern", "drift remediation"] }
    ],
    "behaviouralQuestions": [],
    "difficultQuestions": [
      { "question": "No Kafka experience — how do you cope?", "answerFramework": "Honest bridge from streaming basics.", "bridgeStrategy": "Acknowledge gap, map to SQS/Kinesis." }
    ],
    "technicalPrepChecklist": [
      { "topic": "Kafka fundamentals", "priority": "high", "rationale": "No project evidence; needed for JD.", "suggestedResources": ["Kafka docs"] }
    ],
    "questionsToAsk": [ { "question": "How does the team run on-call?", "rationale": "ops maturity" } ],
    "coachingNotes": "Lead with the operator project.",
    "skillTransfer": [
      { "jdSkill": "Kubernetes", "tier": "demonstrated", "projectId": "p1", "projectName": "AI Applications",
        "evidenceRefs": [ { "source": "component", "id": "c1", "label": "EKS self-healing operator" } ],
        "narrative": "The JD needs Kubernetes; in AI Applications you built an EKS self-healing operator — that transfers directly." },
      { "jdSkill": "Kafka", "tier": "gap", "projectId": null, "projectName": null, "evidenceRefs": [],
        "narrative": "No documented Kafka work; prepare streaming fundamentals." }
    ]
  }
}
```

- [ ] **Step 2: Write `phone-screen.json`** (requires the three phone fields)

```json
{
  "input": {
    "analysisXml": "<analysis><fit>STRONG</fit></analysis>",
    "stage": "phone-screen",
    "candidateSets": []
  },
  "output": {
    "stage": "phone-screen",
    "stageDescription": "Recruiter phone screen — fit, motivation, comp.",
    "technicalQuestions": [],
    "behaviouralQuestions": [
      { "question": "Tell me about yourself.", "answerFramework": "Career arc grounded in analysis.", "sourceProject": "AI Applications", "difficulty": "easy", "keyPoints": ["trajectory", "impact"] }
    ],
    "difficultQuestions": [],
    "technicalPrepChecklist": [],
    "questionsToAsk": [ { "question": "What does success look like in 90 days?", "rationale": "shows ownership" } ],
    "coachingNotes": "Keep it concise and confident.",
    "careerArcSummary": "Cloud/platform engineer moving from IaC into AI-augmented delivery, with verified AWS and Kubernetes work.",
    "jdTalkingPoints": [
      { "point": "Owns end-to-end AWS delivery", "evidence": "AI Applications pipeline" }
    ],
    "compScript": { "targetEcho": "Targeting £X base.", "marketContext": null, "deflectTemplate": "Happy to align once we confirm scope." }
  }
}
```

- [ ] **Step 3: Write `behavioural.json`**

```json
{
  "input": {
    "analysisXml": "<analysis><fit>STRONG</fit></analysis>",
    "stage": "behavioural",
    "candidateSets": []
  },
  "output": {
    "stage": "behavioural",
    "stageDescription": "Behavioural round — STAR stories.",
    "technicalQuestions": [],
    "behaviouralQuestions": [
      { "question": "Tell me about a conflict you resolved.", "answerFramework": "STAR: Situation (migration), Task, Action (I led), Result (quantified).", "sourceProject": "cdk-monitoring", "difficulty": "medium", "keyPoints": ["ownership", "influence without authority"] }
    ],
    "difficultQuestions": [
      { "question": "Tell me about a failure.", "answerFramework": "Honest example with lesson.", "bridgeStrategy": "Show growth, not blame." }
    ],
    "technicalPrepChecklist": [],
    "questionsToAsk": [ { "question": "How does the team give feedback?", "rationale": "culture read" } ],
    "coachingNotes": "Anchor every story in a real, documented experience."
  }
}
```

- [ ] **Step 4: Write the Tier 1 suite test**

```typescript
/** @format */
import phoneScreen from './fixtures/phone-screen.json';
import technical from './fixtures/technical.json';
import behavioural from './fixtures/behavioural.json';
import { runGraders } from './graders.js';
import type { EvalInput } from './graders.js';
import { schemaGrader } from './graders/schema-grader.js';
import { groundingGrader } from './graders/grounding-grader.js';
import { stageFocusGrader } from './graders/stage-focus-grader.js';
import { honestyGrader } from './graders/honesty-grader.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const GRADERS = [schemaGrader, groundingGrader, stageFocusGrader, honestyGrader];
const FIXTURES = [
    { name: 'phone-screen', fx: phoneScreen },
    { name: 'technical', fx: technical },
    { name: 'behavioural', fx: behavioural },
];

describe('Tier 1 coach evals — gold fixtures pass all graders', () => {
    for (const { name, fx } of FIXTURES) {
        it(`${name} fixture passes every grader`, () => {
            const input = fx.input as unknown as EvalInput;
            const output = fx.output as unknown as InterviewCoachResult;
            const report = runGraders(GRADERS, input, output);
            const failures = report.results.flatMap(r => r.failures);
            expect(failures).toEqual([]);
            expect(report.pass).toBe(true);
        });
    }
});
```

- [ ] **Step 5: Enable JSON imports if needed**

Run: `npx jest src/evals/coach-evals.test.ts`
If it fails with a JSON-import/`resolveJsonModule` error, add to `applications/job-strategist/tsconfig.json` `compilerOptions`: `"resolveJsonModule": true`. Re-run.
Expected after fix: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/evals/fixtures applications/job-strategist/src/evals/coach-evals.test.ts applications/job-strategist/tsconfig.json
git commit -m "test(job-strategist): Tier 1 coach eval suite over synthetic fixtures"
```

---

## Task 7: Tier 2 LLM-judge scaffold (gated, no live calls in CI)

**Files:**
- Create: `applications/job-strategist/src/evals/live/judge.ts`
- Create: `applications/job-strategist/src/evals/live/run-live-evals.ts`
- Create: `applications/job-strategist/src/evals/live/capture-fixture.ts`
- Test: `applications/job-strategist/src/evals/live/judge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { JUDGE_AXES, buildJudgePrompt, JUDGE_TOOL, formatReport } from './judge.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const input = { analysisXml: '<a/>', candidateSets: [], stage: 'technical-1' } as unknown as EvalInput;
const output = { stage: 'technical-1', coachingNotes: 'n' } as unknown as InterviewCoachResult;

describe('judge scaffold', () => {
    it('exposes the three subjective axes', () => {
        expect(JUDGE_AXES).toEqual(['narrative-faithfulness', 'stage-focus', 'hallucination-scan']);
    });
    it('buildJudgePrompt embeds the stage and the output JSON', () => {
        const p = buildJudgePrompt(input, output);
        expect(p).toContain('technical-1');
        expect(p).toContain('coachingNotes');
        expect(p).toContain('narrative-faithfulness');
    });
    it('JUDGE_TOOL requires per-axis verdicts', () => {
        expect(JUDGE_TOOL.inputSchema.required).toContain('verdicts');
    });
    it('formatReport renders a markdown table with pass/fail', () => {
        const md = formatReport('technical', [
            { axis: 'stage-focus', pass: true, score: 1, reasoning: 'ok' },
        ]);
        expect(md).toContain('| stage-focus |');
        expect(md).toContain('technical');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/evals/live/judge.test.ts`
Expected: FAIL — `Cannot find module './judge.js'`.

- [ ] **Step 3: Write `judge.ts`**

```typescript
/** @format */
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

export const JUDGE_AXES = ['narrative-faithfulness', 'stage-focus', 'hallucination-scan'] as const;
export type JudgeAxis = (typeof JUDGE_AXES)[number];

export interface JudgeVerdict {
    axis: JudgeAxis;
    pass: boolean;
    score: number; // 0..1
    reasoning: string;
}

/** Forced-tool schema the judge model must satisfy. */
export const JUDGE_TOOL = {
    name: 'emit_judge_verdicts',
    description: 'Emit one verdict per subjective coaching axis.',
    inputSchema: {
        type: 'object',
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        axis: { type: 'string', enum: [...JUDGE_AXES] },
                        pass: { type: 'boolean' },
                        score: { type: 'number' },
                        reasoning: { type: 'string' },
                    },
                    required: ['axis', 'pass', 'score', 'reasoning'],
                    additionalProperties: false,
                },
            },
        },
        required: ['verdicts'],
        additionalProperties: false,
    },
} as const;

/** Build the judge user prompt for one fixture's output. */
export function buildJudgePrompt(input: EvalInput, output: InterviewCoachResult): string {
    return [
        `You are grading an interview-coaching brief for the "${input.stage}" stage.`,
        `Judge ONLY these axes, one verdict each: ${JUDGE_AXES.join(', ')}.`,
        `- narrative-faithfulness: does each skillTransfer narrative follow from its cited evidence, with no embellishment?`,
        `- stage-focus: is the content genuinely right for this stage?`,
        `- hallucination-scan: any claim not traceable to the analysis or candidate evidence?`,
        ``,
        `## Analysis`,
        input.analysisXml,
        ``,
        `## Coaching output (JSON)`,
        JSON.stringify(output, null, 2),
        ``,
        `Call emit_judge_verdicts with one verdict per axis.`,
    ].join('\n');
}

/** Render verdicts as a markdown report. */
export function formatReport(fixtureName: string, verdicts: JudgeVerdict[]): string {
    const rows = verdicts.map(v => `| ${v.axis} | ${v.pass ? 'PASS' : 'FAIL'} | ${v.score.toFixed(2)} | ${v.reasoning} |`);
    return [
        `### Tier 2 judge — ${fixtureName}`,
        ``,
        `| axis | result | score | reasoning |`,
        `| --- | --- | --- | --- |`,
        ...rows,
    ].join('\n');
}
```

- [ ] **Step 4: Write `run-live-evals.ts`** (gated runner — invokes real coach + judge)

```typescript
/** @format */
/**
 * Tier 2 live eval runner. Gated behind RUN_LIVE_EVALS=1 so default `jest` and CI
 * never call Bedrock. Run manually before prompt changes:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/live/run-live-evals.ts
 *
 * Steps (intentionally thin — wiring, not logic): for each gold input, invoke the
 * real coach (Sonnet), run Tier 1 graders on the output, then call the judge model
 * with JUDGE_TOOL and print formatReport per fixture. Implementation of the Bedrock
 * calls reuses the existing coachAgent + BaseAgent Converse path.
 */
export const LIVE_ENABLED = process.env.RUN_LIVE_EVALS === '1';

if (!LIVE_ENABLED) {
    // eslint-disable-next-line no-console
    console.log('RUN_LIVE_EVALS not set — skipping live evals.');
    process.exit(0);
}

// eslint-disable-next-line no-console
console.log('Live evals: invoke coachAgent over gold inputs, run graders + judge, print formatReport. See judge.ts.');
```

- [ ] **Step 5: Write `capture-fixture.ts`** (deferred one-time real-run capture)

```typescript
/** @format */
/**
 * One-time helper to capture a real coach run and seed a fixture's `output`.
 * Deferred per spec (v1 is fully offline). When needed:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/live/capture-fixture.ts <stage>
 * It should invoke coachAgent.execute with a chosen (analysis, candidateSets, stage),
 * then write { input, output } JSON to src/evals/fixtures/<stage>.json.
 */
export const CAPTURE_USAGE = 'RUN_LIVE_EVALS=1 npx tsx src/evals/live/capture-fixture.ts <stage>';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/evals/live/judge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add applications/job-strategist/src/evals/live
git commit -m "feat(job-strategist): Tier 2 coach LLM-judge scaffold (gated, no CI live calls)"
```

---

## Task 8: Extract COACH_BASE (drop stale JSON example)

**Files:**
- Create: `applications/job-strategist/src/prompts/coach/base.ts`
- Test: `applications/job-strategist/src/prompts/coach/base.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { COACH_BASE_TEXT } from './base.js';

describe('COACH_BASE_TEXT', () => {
    it('keeps the truthfulness mandate', () => {
        expect(COACH_BASE_TEXT).toContain('TRUTHFULNESS MANDATE');
        expect(COACH_BASE_TEXT).toContain('NEVER fabricate');
    });
    it('keeps ESL coaching guidance', () => {
        expect(COACH_BASE_TEXT).toContain('ESL');
    });
    it('drops the stale output-example fields', () => {
        expect(COACH_BASE_TEXT).not.toContain('kbCoverage');
        expect(COACH_BASE_TEXT).not.toContain('conceptExplanation');
        expect(COACH_BASE_TEXT).not.toContain('kbCoverageReport');
    });
    it('carries no per-stage branch headers (those live in stage files)', () => {
        expect(COACH_BASE_TEXT).not.toContain('STAGE 1: BEHAVIOURAL');
        expect(COACH_BASE_TEXT).not.toContain('STAGE 2: TECHNICAL');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/prompts/coach/base.test.ts`
Expected: FAIL — `Cannot find module './base.js'`.

- [ ] **Step 3: Write `base.ts`**

Lift the role, Phase-6 scope, TRUTHFULNESS MANDATE, STAGE TRANSITION PROTOCOL, POST-INTERVIEW DEBRIEF, and ESL sections from the current `coach-persona.ts` into a single shared text. Replace the entire `OUTPUT FORMAT` JSON example with a short prose contract. Remove every per-stage `STAGE N:` block and the phone-screen extra-fields block (those move to stage files).

```typescript
/** @format */

/**
 * Shared coach base — role, truthfulness mandate, transition/debrief protocol, ESL.
 * SOLE source of the shared grounding rules. Per-stage instructions live in
 * ./stages/*. The output contract is stated in prose: structure is enforced by the
 * forced tool schema in coach-agent.ts (no drifting JSON example here).
 */
export const COACH_BASE_TEXT = [
    `[ROLE]`,
    `You are an experienced Interview Coach specialising in technical roles.`,
    `You prepare candidates for specific interview stages using verified`,
    `evidence from their portfolio, projects, and professional experience.`,
    ``,
    `[SCOPE]`,
    `You receive: the Strategist Agent's full analysis (XML), the current interview`,
    `stage, and any previous interview feedback. Tailor preparation to that stage.`,
    ``,
    `[TRUTHFULNESS MANDATE]`,
    `⚠️ CRITICAL: All interview answers and STAR responses MUST be grounded`,
    `exclusively in the candidate's verified experience.`,
    `Before generating any answer: search the analysis for relevant experience;`,
    `cite the exact source ("Based on your [Project X / role / repo Y]…"); if NO`,
    `evidence exists for a topic, do NOT fabricate — flag it.`,
    `NEVER fabricate interview scenarios, achievements, or STAR responses. Every`,
    `story must trace to a real, documented experience.`,
    ``,
    `[OUTPUT CONTRACT]`,
    `Emit the coaching brief by calling the emit_interview_coaching tool. The tool`,
    `schema is authoritative — populate exactly the fields it defines for this stage,`,
    `omitting optional fields that do not apply. Do not invent fields.`,
    ``,
    `[STAGE TRANSITION PROTOCOL]`,
    `When the stage changes: congratulate briefly (1 sentence); ask what they learned`,
    `about the next round (who, format, duration, panel or 1:1); adjust prep to the`,
    `interviewer role (HR→behavioural/comp; Hiring Manager→team fit/vision;`,
    `Peer/SDE→technical depth; Senior/Principal→system design; Bar Raiser→leadership`,
    `principles); deliver a stage-specific checklist (top 3 areas, key STAR stories,`,
    `questions to ask, logistics).`,
    ``,
    `[POST-INTERVIEW DEBRIEF PROTOCOL]`,
    `After any completed stage: ask what was actually asked; help reconstruct answers;`,
    `give objective performance analysis (what went well with specifics, what to`,
    `improve, unexpected topics to add to prep); draft a thank-you/follow-up email`,
    `(polished ESL-corrected English, references a specific topic, reiterates one key`,
    `qualification, non-pushy close, under 150 words).`,
    ``,
    `[ESL COACHING]`,
    `Identify potential ESL communication challenges; give pronunciation guidance for`,
    `technical terms where relevant; suggest confident phrasing for hedging language.`,
].join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/prompts/coach/base.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/prompts/coach/base.ts applications/job-strategist/src/prompts/coach/base.test.ts
git commit -m "feat(job-strategist): COACH_BASE shared prompt (drop stale output example)"
```

---

## Task 9: Stage deltas + resolver + assembler

**Files:**
- Create: `applications/job-strategist/src/prompts/coach/stages/phone-screen.ts`
- Create: `applications/job-strategist/src/prompts/coach/stages/technical.ts`
- Create: `applications/job-strategist/src/prompts/coach/stages/behavioural.ts`
- Create: `applications/job-strategist/src/prompts/coach/stages/index.ts`
- Test: `applications/job-strategist/src/prompts/coach/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { resolveCoachBranch, assembleCoachSystemPrompt } from './stages/index.js';

function text(blocks: { text?: string }[]): string {
    return blocks.map(b => b.text ?? '').join('\n');
}

describe('resolveCoachBranch', () => {
    it('maps canonical stages to branches', () => {
        expect(resolveCoachBranch('phone-screen')).toBe('phone-screen');
        expect(resolveCoachBranch('technical-1')).toBe('technical');
        expect(resolveCoachBranch('technical-2')).toBe('technical');
        expect(resolveCoachBranch('behavioural')).toBe('behavioural');
        expect(resolveCoachBranch('final-round')).toBe('general');
        expect(resolveCoachBranch('applied')).toBe('general');
    });
});

describe('assembleCoachSystemPrompt', () => {
    it('always includes the base and a cache point', () => {
        const blocks = assembleCoachSystemPrompt('technical-1') as { text?: string; cachePoint?: unknown }[];
        expect(text(blocks)).toContain('TRUTHFULNESS MANDATE');
        expect(blocks.some(b => b.cachePoint)).toBe(true);
    });
    it('technical includes the skill-transfer delta and not phone-screen fields', () => {
        const t = text(assembleCoachSystemPrompt('technical-1') as { text?: string }[]);
        expect(t).toContain('SKILL TRANSFER');
        expect(t).not.toContain('careerArcSummary');
    });
    it('phone-screen includes the phone delta fields', () => {
        const t = text(assembleCoachSystemPrompt('phone-screen') as { text?: string }[]);
        expect(t).toContain('careerArcSummary');
        expect(t).toContain('compScript');
    });
    it('general stage (final-round) appends no stage delta beyond base', () => {
        const t = text(assembleCoachSystemPrompt('final-round') as { text?: string }[]);
        expect(t).toContain('TRUTHFULNESS MANDATE');
        expect(t).not.toContain('SKILL TRANSFER');
    });
    it('places the cache point after the base, before any stage delta', () => {
        const blocks = assembleCoachSystemPrompt('phone-screen') as { text?: string; cachePoint?: unknown }[];
        const cacheIdx = blocks.findIndex(b => b.cachePoint);
        const baseIdx = blocks.findIndex(b => (b.text ?? '').includes('TRUTHFULNESS MANDATE'));
        expect(baseIdx).toBeLessThan(cacheIdx);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/prompts/coach/index.test.ts`
Expected: FAIL — `Cannot find module './stages/index.js'`.

- [ ] **Step 3: Write `phone-screen.ts`**

```typescript
/** @format */
/** Phone-screen delta — extra fields required for this stage (see coachToolForStage). */
export const PHONE_SCREEN_DELTA = [
    `── PHONE SCREEN ───────────────────────────────────────────────────`,
    `(interview_stage = "phone-screen")`,
    `• Generate expected recruiter/behavioural questions for the role/company.`,
    `• For EACH, produce a complete STAR answer grounded in cited real experience.`,
    `• ALSO emit these fields (required for phone-screen):`,
    `  - careerArcSummary — 2-3 sentence trajectory grounded in the analysis.`,
    `  - jdTalkingPoints — strongest VERIFIED matches vs the JD; each {point, evidence}`,
    `    cites a real source.`,
    `  - compScript — {targetEcho, marketContext, deflectTemplate}. Use the candidate's`,
    `    target + the market range from the stage-prep calibration block if present. If`,
    `    NO market range is provided, set marketContext to null and do NOT invent figures.`,
].join('\n');
```

- [ ] **Step 4: Write `technical.ts`**

```typescript
/** @format */
/** Technical delta — two-part answers + grounded skill-transfer block. */
export const TECHNICAL_DELTA = [
    `── TECHNICAL INTERVIEW ────────────────────────────────────────────`,
    `(interview_stage = "technical-1" or "technical-2")`,
    `• Generate expected technical questions from JD requirements + gap analysis.`,
    `• For EACH, produce: **Concept** (clear definition) + **Your Experience** (specific`,
    `  project/task where the candidate worked with it, concrete details).`,
    `• Coverage (prioritise from JD): systems/networking, coding/DS&A, AWS services &`,
    `  architecture, CI/CD & IaC, security fundamentals, observability.`,
    `• Honest gaps: if no experience with a topic, provide a 2–5 day study guide.`,
    ``,
    `── SKILL TRANSFER (technical stage) ───────────────────────────────`,
    `When a "Candidate project evidence per JD skill" block is present:`,
    `• Emit one skillTransfer entry per listed JD skill.`,
    `• Choose the best candidate (demonstrated > declared > claimed); cite its EXACT ids.`,
    `• narrative: "The JD needs <skill>; in <project> you <did X from the candidate row> —`,
    `  here is how that transfers." Ground every claim in the cited row; invent nothing.`,
    `• No candidate → tier="gap", projectId=null, evidenceRefs=[], honest bridge guidance.`,
    `• In technicalPrepChecklist rationale, name the matched project when a topic maps to one.`,
].join('\n');
```

- [ ] **Step 5: Write `behavioural.ts`**

```typescript
/** @format */
/** Behavioural delta — STAR frameworks across required competencies. */
export const BEHAVIOURAL_DELTA = [
    `── BEHAVIOURAL ROUND ──────────────────────────────────────────────`,
    `(interview_stage = "behavioural")`,
    `• Generate expected behavioural questions for the role/company; prioritise`,
    `  Leadership Principles for Amazon/AWS-culture companies.`,
    `• For EACH, produce a complete STAR answer (Situation/Task/Action/Result), citing`,
    `  the real source; quantify the Result where data exists.`,
    `• Cover: conflict resolution, ownership & bias for action, learning from failure,`,
    `  influencing without authority, customer obsession.`,
    `• If the KB lacks a scenario for a required type, state so and ask the candidate`,
    `  to share a real experience — never fabricate one.`,
].join('\n');
```

- [ ] **Step 6: Write `stages/index.ts`**

```typescript
/** @format */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { InterviewStage } from '@bedrock/shared';
import { COACH_BASE_TEXT } from '../base.js';
import { PHONE_SCREEN_DELTA } from './phone-screen.js';
import { TECHNICAL_DELTA } from './technical.js';
import { BEHAVIOURAL_DELTA } from './behavioural.js';

export type CoachBranch = 'phone-screen' | 'technical' | 'behavioural' | 'general';

/** Map a canonical interview stage to its coach branch. */
export function resolveCoachBranch(stage: InterviewStage): CoachBranch {
    switch (stage) {
        case 'phone-screen': return 'phone-screen';
        case 'technical-1':
        case 'technical-2': return 'technical';
        case 'behavioural': return 'behavioural';
        default: return 'general';
    }
}

const DELTA: Record<CoachBranch, string> = {
    'phone-screen': PHONE_SCREEN_DELTA,
    technical: TECHNICAL_DELTA,
    behavioural: BEHAVIOURAL_DELTA,
    general: '',
};

/**
 * Assemble the stage-specific system prompt: shared base, cache point (so the large
 * base is cached across all stages), then the small stage delta. The model only ever
 * sees its own branch — no self-selection among branches it shouldn't be on.
 */
export function assembleCoachSystemPrompt(stage: InterviewStage): SystemContentBlock[] {
    const delta = DELTA[resolveCoachBranch(stage)];
    const blocks: SystemContentBlock[] = [
        { text: COACH_BASE_TEXT },
        { cachePoint: { type: 'default' } } as SystemContentBlock,
    ];
    if (delta) blocks.push({ text: delta });
    return blocks;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/prompts/coach/index.test.ts`
Expected: PASS (resolver + assembly tests).

- [ ] **Step 8: Commit**

```bash
git add applications/job-strategist/src/prompts/coach/stages applications/job-strategist/src/prompts/coach/index.test.ts
git commit -m "feat(job-strategist): per-stage coach prompt deltas + assembler (canonical stages)"
```

---

## Task 10: Wire coach-agent to the assembler; hard-cut old persona

**Files:**
- Modify: `applications/job-strategist/src/agents/coach-agent.ts`
- Delete: `applications/job-strategist/src/prompts/coach-persona.ts`
- Delete: `applications/job-strategist/src/prompts/coach-persona.test.ts`

- [ ] **Step 1: Update the import + config in coach-agent.ts**

Replace the import line:

```typescript
import { COACH_PERSONA_SYSTEM_PROMPT } from '../prompts/coach-persona.js';
```

with:

```typescript
import { assembleCoachSystemPrompt } from '../prompts/coach/stages/index.js';
```

Remove `systemPrompt: COACH_PERSONA_SYSTEM_PROMPT,` from the `COACH_CONFIG` object (drop the line entirely — `AgentConfig.systemPrompt` is now set per-stage in `getConfig`).

Update `getConfig` to assemble the stage prompt:

```typescript
    protected getConfig(_input: CoachAgentInput, ctx: StrategistPipelineContext): AgentConfig {
        return {
            ...COACH_CONFIG,
            systemPrompt: assembleCoachSystemPrompt(ctx.interviewStage),
            tool: coachToolForStage(ctx.interviewStage),
        };
    }
```

If TypeScript flags `COACH_CONFIG` for a missing required `systemPrompt`, type it so the field is optional at the constant and always supplied in `getConfig`:

```typescript
const COACH_CONFIG: Omit<AgentConfig, 'systemPrompt'> = {
    agentName: 'strategist-coach',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: COACH_MAX_TOKENS,
    thinkingBudget: COACH_THINKING_BUDGET,
    tool: COACH_TOOL,
};
```

- [ ] **Step 2: Delete the old persona files**

```bash
git rm applications/job-strategist/src/prompts/coach-persona.ts applications/job-strategist/src/prompts/coach-persona.test.ts
```

- [ ] **Step 3: Confirm no dangling importers remain**

Run: `grep -rn "COACH_PERSONA_SYSTEM_PROMPT\|coach-persona" applications/job-strategist/src`
Expected: no matches (only `dist/` build output may still reference it; that regenerates on build).

- [ ] **Step 4: Type-check**

Run (from `applications/job-strategist`): `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full package test suite (regression guard)**

Run: `npm test`
Expected: PASS — existing coach-agent tests, the new eval suite, and the prompt tests all green. The Tier 1 eval suite is the regression guard: if the refactor changed observable contract behaviour, a grader fails here.

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/agents/coach-agent.ts
git commit -m "refactor(job-strategist): coach uses per-stage assembled prompt; remove fat persona"
```

---

## Self-Review

**Spec coverage:**
- Tiered evals — Tier 1 graders (Tasks 1–6), Tier 2 judge scaffold (Task 7). ✓
- Fully-offline v1 synthetic fixtures — Task 6; real-run capture deferred (Task 7 `capture-fixture.ts`). ✓
- v1 stages phone-screen / technical / behavioural — fixtures + stage deltas (Tasks 6, 9). ✓
- 4 graders (schema, grounding, stage-focus, honesty) — Tasks 2–5. ✓
- Skills-pattern folders + base sole source + canonical-stage resolver + cache-after-base — Tasks 8–9. ✓
- Hard-cut `COACH_PERSONA_SYSTEM_PROMPT`, no shim, both importers updated — Task 10. ✓
- Drop stale JSON output example — Task 8. ✓
- system-design out of scope — not in stage map (resolves to `general`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows assertions.

**Type consistency:** `Grader`/`GraderResult`/`EvalInput`/`mkResult`/`allowedIds`/`allowedProjectIds` defined in Task 1 and used unchanged in Tasks 2–6. `resolveCoachBranch`/`assembleCoachSystemPrompt`/`CoachBranch` defined in Task 9 and consumed in Task 10. `CoachOutputSchema`/`PHONE_SCREEN_FIELDS` exported in Task 2, imported by schema-grader. `validateSkillTransfer`, `SkillCandidateSet`, `SkillTransferEntry`, `InterviewStage`, `InterviewCoachResult` all from `@bedrock/shared`.

**Note on lint debt (memory `ai-applications-lint-debt`):** there is no `lint` script in this package (`package.json` has only `test`, `test:integration`, `build`, `typecheck`). Per the git-commit skill, run `npm run typecheck` before commits where types change (Tasks 2, 10). No lint gate exists to satisfy.
