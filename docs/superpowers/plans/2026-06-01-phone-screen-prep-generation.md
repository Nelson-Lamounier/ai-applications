# Phone Screen Prep Generation — Implementation Plan (Spec 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Coach Agent emit three phone-screen-specific prep fields (career arc, JD talking points, comp script), grounded in the Spec-1 ontology, served + rendered in the Phone Screen workspace.

**Architecture:** Extend the unified `emit_interview_coaching` schema with three *optional* fields the model emits only for `phone-screen`. A new shared `constraint-block` module fetches Spec-1 ontology rows and renders a calibration block injected into the Coach **user message** (the system prompt is statically cached, so per-application data must not touch it). The fields ride inside `InterviewCoachResult` → persisted whole in `coaching_content.topics_to_study` → served unchanged by `GET /:slug`. UI renders them.

**Tech Stack:** TypeScript (ESM/NodeNext, `.js` imports), Jest, AWS Bedrock Converse (Haiku 4.5), `pg`, Hono (admin-api), React/TanStack (tucaken-app).

**Spec:** `docs/superpowers/specs/2026-06-01-phone-screen-prep-generation-design.md`

**Depends on:** Spec 1 (PR #108) merged to `develop` — provides `RdsStagePrepOntologyRepository`, `toRoleFamily`, `toCompSeniority`, and the ontology types.

---

## Two PRs (cross-repo)

- **PART A — `ai-applications`** (Tasks A1–A8): coach schema + constraint block + synthesis wiring + env. Merge first; optional fields just populate `coaching_content` until the UI ships.
- **PART B — `tucaken-app`** (Tasks B1–B4): admin-api `/coach` body + `PhoneScreenWorkspace` render + types + dispatch. Depends on PART A.

Run PART A to completion (own branch/PR in `ai-applications`), then PART B (own branch/PR in `tucaken-app`).

---

## PART A File Structure (`ai-applications`)

| File | Responsibility | Action |
|---|---|---|
| `applications/shared/src/strategist-types.ts` | Add 3 optional fields + their types to `InterviewCoachResult` | Modify |
| `applications/shared/src/stage-prep/constraint-block.ts` | `StagePrepConstraints`, `buildStagePrepConstraintBlock`, `loadStagePrepConstraints`, `normalizeCompanyKey`, reader interface | Create |
| `applications/shared/src/stage-prep/constraint-block.test.ts` | Unit tests (render + load via fake reader) | Create |
| `applications/shared/src/stage-prep/index.ts` | Export the new module | Modify |
| `applications/job-strategist/src/agents/coach-agent.ts` | Schema props + Zod optional + input + user-message append + `executeCoachAgent` arg | Modify |
| `applications/job-strategist/src/agents/coach-agent.test.ts` | Parse accepts present/absent optional fields | Create |
| `applications/job-strategist/src/prompts/coach-persona.ts` | Static instruction to emit phone-screen fields | Modify |
| `applications/job-strategist/src/env-coach.ts` | Parse `COMPENSATION_TARGET` + `REGION` | Modify |
| `applications/job-strategist/src/env-coach.test.ts` | Env parsing incl. new optional vars | Create |
| `applications/job-strategist/src/run-coach.ts` | Load `research`, build constraints, pass to coach | Modify |

**Conventions (verified):** files start `/** @format */` (shared) or `/**\n * @format`; ESM `.js` imports; Jest `import { describe, it, expect, jest } from '@jest/globals';`. `applications/shared` test cmd is `npx jest`; `applications/job-strategist` — confirm its test script before running (Step in A6).

---

## Task A1: Extend `InterviewCoachResult` with phone-screen fields

**Files:**
- Modify: `applications/shared/src/strategist-types.ts` (after `InterviewCoachResult`, ~line 653)

- [ ] **Step 1: Add the supporting types + optional fields**

Insert these interfaces immediately BEFORE `InterviewCoachResult` (before line 632's doc comment):

```typescript
/**
 * A phone-screen talking point: a verified strength cross-referenced against the JD.
 */
export interface PhoneScreenTalkingPoint {
    /** The talking point to make */
    readonly point: string;
    /** The verified evidence backing it (project / role / repo) */
    readonly evidence: string;
}

/**
 * Compensation conversation script for the phone screen.
 * `marketContext` is null when no benchmark row exists — never a fabricated range.
 */
export interface CompScript {
    /** How to state the candidate's target */
    readonly targetEcho: string;
    /** Market context sentence, or null when no benchmark is available */
    readonly marketContext: string | null;
    /** Template for deflecting / framing the comp question */
    readonly deflectTemplate: string;
}
```

Then add these three OPTIONAL fields to `InterviewCoachResult` (after `coachingNotes`, before the closing `}` at line 653):

```typescript
    /** Phone-screen only: 2-3 sentence career-arc narrative */
    readonly careerArcSummary?: string;
    /** Phone-screen only: JD-cross-referenced verified talking points */
    readonly jdTalkingPoints?: PhoneScreenTalkingPoint[];
    /** Phone-screen only: compensation conversation script */
    readonly compScript?: CompScript;
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: clean (a pre-existing ts-jest `TS151002 isolatedModules` warning is unrelated noise — ignore only that).

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/strategist-types.ts
git commit -m "feat(shared): phone-screen fields on InterviewCoachResult"
```

---

## Task A2: `buildStagePrepConstraintBlock` + helpers (TDD)

**Files:**
- Create: `applications/shared/src/stage-prep/constraint-block.ts`
- Test: `applications/shared/src/stage-prep/constraint-block.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from '@jest/globals';
import { buildStagePrepConstraintBlock, normalizeCompanyKey } from './constraint-block.js';
import type { StagePrepConstraints } from './constraint-block.js';

const FULL: StagePrepConstraints = {
    expectation: {
        id: '*|*|phone-screen', companyType: '*', roleFamily: '*', stage: 'phone-screen',
        focusAreas: ['career arc', 'comp alignment'],
        questionPatterns: [{ type: 'career-arc', promptHint: 'walk me through your background' }],
        expectationNote: 'Recruiter-led fit filter.',
    },
    processShape: [{ stage: 'phone-screen', format: 'recruiter screen', note: 'fit + logistics' }],
    comp: {
        id: '*|senior|eu-remote', roleFamily: '*', seniority: 'senior', region: 'eu-remote',
        currency: 'EUR', rangeMin: 80647, rangeP50: 93794, rangeMax: 114300,
    },
    gapTemplates: [{
        id: 'gap-adjacent-pivot', kind: 'gap_handling', title: 'Acknowledge gap, pivot',
        structure: { template: 'I have not used {missing} but {adjacent}...' },
    }],
    compTarget: '95000',
};

describe('buildStagePrepConstraintBlock', () => {
    it('renders focus areas, process, comp range+target, and gap guidance', () => {
        const block = buildStagePrepConstraintBlock(FULL);
        expect(block).toContain('career arc');
        expect(block).toContain('recruiter screen');
        expect(block).toContain('93794');           // market p50
        expect(block).toContain('95000');           // user target
        expect(block).toContain('EUR');
        expect(block).toContain('gap');              // gap-handling guidance mentioned
        expect(block.toLowerCase()).toContain('never');  // truthfulness reminder
    });

    it('omits absent pieces and still returns the truthfulness reminder', () => {
        const empty: StagePrepConstraints = {
            expectation: null, processShape: [], comp: null, gapTemplates: [], compTarget: null,
        };
        const block = buildStagePrepConstraintBlock(empty);
        expect(block).not.toContain('Market compensation');
        expect(block).not.toContain('Typical process');
        expect(block.toLowerCase()).toContain('never');
    });

    it('shows comp target without a market range when comp is null', () => {
        const block = buildStagePrepConstraintBlock({ ...FULL, comp: null });
        expect(block).toContain('95000');
        expect(block).not.toContain('93794');
    });
});

describe('normalizeCompanyKey', () => {
    it('lowercases and strips to alphanumerics', () => {
        expect(normalizeCompanyKey('Amazon Web Services, Inc.')).toBe('amazonwebservicesinc');
        expect(normalizeCompanyKey('Stripe')).toBe('stripe');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/stage-prep/constraint-block.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/** @format */
import type {
    StageExpectation, ProcessStage, CompBenchmark, PrepScaffold, ScaffoldKind,
    CompanyInterviewProfile,
} from './stage-prep-types.js';

/** Reader surface this module needs — RdsStagePrepOntologyRepository satisfies it structurally. */
export interface StagePrepOntologyReader {
    getStageExpectation(companyType: string, roleFamily: string, stage: string): Promise<StageExpectation | null>;
    getCompanyProfile(companyKey: string): Promise<CompanyInterviewProfile | null>;
    getCompBenchmark(roleFamily: string, seniority: string, region: string): Promise<CompBenchmark | null>;
    listScaffolds(kind: ScaffoldKind): Promise<PrepScaffold[]>;
}

/** Resolved ontology data for one stage-prep run. */
export interface StagePrepConstraints {
    readonly expectation: StageExpectation | null;
    readonly processShape: ProcessStage[];
    readonly comp: CompBenchmark | null;
    readonly gapTemplates: PrepScaffold[];
    readonly compTarget: string | null;
}

/** Normalise a free-text company name to a profile lookup key. */
export function normalizeCompanyKey(company: string): string {
    return company.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fetch all ontology constraints for a stage-prep run. companyType is read from
 * the company profile (falls back to '*' when the company is unknown).
 */
export async function loadStagePrepConstraints(
    repo: StagePrepOntologyReader,
    args: {
        targetCompany: string;
        roleFamily: string;
        stage: string;
        seniority: string;
        region: string;
        compTarget: string | null;
    },
): Promise<StagePrepConstraints> {
    const profile = await repo.getCompanyProfile(normalizeCompanyKey(args.targetCompany));
    const companyType = profile?.companyType ?? '*';
    const [expectation, comp, gapTemplates] = await Promise.all([
        repo.getStageExpectation(companyType, args.roleFamily, args.stage),
        repo.getCompBenchmark(args.roleFamily, args.seniority, args.region),
        repo.listScaffolds('gap_handling'),
    ]);
    return {
        expectation,
        processShape: profile?.processShape ?? [],
        comp,
        gapTemplates,
        compTarget: args.compTarget,
    };
}

const TRUTHFULNESS =
    'Calibration changes emphasis, never truthfulness. Ground every point in the candidate’s ' +
    'verified evidence; omit anything you cannot ground.';

/** Render the resolved constraints into a soft calibration block for the Coach user message. */
export function buildStagePrepConstraintBlock(c: StagePrepConstraints): string {
    const lines: string[] = ['## Stage-prep calibration (structural constraints)'];

    if (c.expectation) {
        if (c.expectation.focusAreas.length) {
            lines.push(`Focus areas this stage typically tests: ${c.expectation.focusAreas.join(', ')}.`);
        }
        if (c.expectation.questionPatterns.length) {
            const types = c.expectation.questionPatterns.map(q => q.type).join(', ');
            lines.push(`Common question types: ${types}.`);
        }
        if (c.expectation.expectationNote) lines.push(c.expectation.expectationNote);
    }

    if (c.processShape.length) {
        const steps = c.processShape.map(s => `${s.stage} (${s.format})`).join(' → ');
        lines.push(`Typical process for this company: ${steps}.`);
    }

    if (c.compTarget || c.comp) {
        const parts: string[] = [];
        if (c.compTarget) parts.push(`Candidate’s target: ${c.compTarget}.`);
        if (c.comp) {
            parts.push(
                `Market compensation (${c.comp.currency}, ${c.comp.region}, ${c.comp.seniority}): ` +
                `${c.comp.rangeMin}–${c.comp.rangeMax}, median ${c.comp.rangeP50}.`,
            );
        }
        lines.push(`Compensation context: ${parts.join(' ')}`);
    }

    if (c.gapTemplates.length) {
        const titles = c.gapTemplates.map(g => g.title).join('; ');
        lines.push(`When the candidate has an evidence gap on a topic, use a gap-handling approach (${titles}).`);
    }

    lines.push(TRUTHFULNESS);
    return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/stage-prep/constraint-block.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from the barrel**

In `applications/shared/src/stage-prep/index.ts`, add:

```typescript
export * from './constraint-block.js';
```

(The package root `applications/shared/src/index.ts` already does `export * from './stage-prep/index.js'` from Spec 1, so this propagates automatically.)

- [ ] **Step 6: Typecheck + commit**

Run: `cd applications/shared && npx tsc --noEmit` (expect clean)

```bash
git add applications/shared/src/stage-prep/constraint-block.ts applications/shared/src/stage-prep/constraint-block.test.ts applications/shared/src/stage-prep/index.ts
git commit -m "feat(shared): stage-prep constraint block + loader (TDD)"
```

---

## Task A3: `loadStagePrepConstraints` via a fake reader (TDD)

**Files:**
- Modify: `applications/shared/src/stage-prep/constraint-block.test.ts` (append)

- [ ] **Step 1: Append the failing test**

```typescript
import { loadStagePrepConstraints } from './constraint-block.js';
import type { StagePrepOntologyReader } from './constraint-block.js';

function fakeReader(over: Partial<StagePrepOntologyReader> = {}): StagePrepOntologyReader {
    return {
        getStageExpectation: async () => null,
        getCompanyProfile:   async () => null,
        getCompBenchmark:    async () => null,
        listScaffolds:       async () => [],
        ...over,
    };
}

describe('loadStagePrepConstraints', () => {
    it('uses companyType from the profile and passes it to getStageExpectation', async () => {
        let seenCompanyType = '';
        const reader = fakeReader({
            getCompanyProfile: async () => ({
                companyKey: 'amazon', displayName: 'Amazon', companyType: 'faang',
                leadershipPrinciples: [], processShape: [{ stage: 'phone-screen', format: 'recruiter screen', note: 'n' }],
                valuesTaxonomy: [],
            }),
            getStageExpectation: async (ct) => { seenCompanyType = ct; return null; },
        });
        const c = await loadStagePrepConstraints(reader, {
            targetCompany: 'Amazon', roleFamily: 'backend', stage: 'phone-screen',
            seniority: 'senior', region: 'us', compTarget: '200000',
        });
        expect(seenCompanyType).toBe('faang');
        expect(c.processShape).toHaveLength(1);
        expect(c.compTarget).toBe('200000');
    });

    it('falls back to companyType "*" when the company is unknown', async () => {
        let seenCompanyType = '';
        const reader = fakeReader({ getStageExpectation: async (ct) => { seenCompanyType = ct; return null; } });
        await loadStagePrepConstraints(reader, {
            targetCompany: 'Some Unknown GmbH', roleFamily: 'devops', stage: 'phone-screen',
            seniority: 'mid', region: 'eu-remote', compTarget: null,
        });
        expect(seenCompanyType).toBe('*');
    });
});
```

- [ ] **Step 2: Run — expect PASS immediately** (the implementation from A2 already satisfies this; this task adds coverage for the loader's companyType resolution).

Run: `cd applications/shared && npx jest src/stage-prep/constraint-block.test.ts`
Expected: PASS. If it fails, fix `loadStagePrepConstraints` until green.

- [ ] **Step 3: Commit**

```bash
git add applications/shared/src/stage-prep/constraint-block.test.ts
git commit -m "test(shared): loadStagePrepConstraints companyType resolution"
```

---

## Task A4: Coach schema + Zod + input + user-message (TDD)

**Files:**
- Modify: `applications/job-strategist/src/agents/coach-agent.ts`
- Test: `applications/job-strategist/src/agents/coach-agent.test.ts`

- [ ] **Step 1: Add optional fields to the tool schema** (`coach-agent.ts`, inside `COACH_TOOL.inputSchema.properties`, after `coachingNotes` at line 129). Add these properties but DO NOT add them to the `required` array:

```typescript
            careerArcSummary: { type: 'string' },
            jdTalkingPoints: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        point:    { type: 'string' },
                        evidence: { type: 'string' },
                    },
                    required: ['point', 'evidence'],
                    additionalProperties: false,
                },
            },
            compScript: {
                type: 'object',
                properties: {
                    targetEcho:      { type: 'string' },
                    marketContext:   { type: ['string', 'null'] },
                    deflectTemplate: { type: 'string' },
                },
                required: ['targetEcho', 'marketContext', 'deflectTemplate'],
                additionalProperties: false,
            },
```

- [ ] **Step 2: Add the optional fields to `CoachOutputSchema`** (after `coachingNotes: z.string(),` at line 170):

```typescript
    careerArcSummary: z.string().optional(),
    jdTalkingPoints: z.array(z.object({
        point:    z.string(),
        evidence: z.string(),
    }).strict()).optional(),
    compScript: z.object({
        targetEcho:      z.string(),
        marketContext:   z.string().nullable(),
        deflectTemplate: z.string(),
    }).strict().optional(),
```

- [ ] **Step 3: Extend `CoachAgentInput`** (replace the interface at lines 35-38):

```typescript
export interface CoachAgentInput {
    /** Strategist Agent's analysis containing the full XML */
    readonly analysis: StrategistAnalysisResult;
    /** Optional stage-prep calibration block appended to the user message (phone-screen). */
    readonly constraintBlock?: string;
}
```

- [ ] **Step 4: Append the constraint block in `buildCoachMessage`** (modify the function at lines 187-209 to accept + append the block). Replace the function with:

```typescript
function buildCoachMessage(
    analysis: StrategistAnalysisResult,
    ctx: StrategistPipelineContext,
    constraintBlock?: string,
): string {
    const sections: string[] = [
        `## Interview Stage: ${ctx.interviewStage}`,
        `Target Role: ${ctx.targetRole}`,
        `Target Company: ${ctx.targetCompany}`,
        `Overall Fit: ${analysis.metadata.overallFitRating}`,
        `Recommendation: ${analysis.metadata.applicationRecommendation}`,
        '',
        '## Full Analysis',
        '--- BEGIN ANALYSIS ---',
        analysis.analysisXml,
        '--- END ANALYSIS ---',
        '',
    ];
    if (constraintBlock) {
        sections.push(constraintBlock, '');
    }
    sections.push(
        `Prepare interview coaching for the "${ctx.interviewStage}" stage. ` +
        'Use ONLY verified skills and projects from the analysis. ' +
        'Return the JSON coaching brief.',
    );
    return sections.join('\n');
}
```

- [ ] **Step 5: Pass the block through `buildUserMessage`** (modify the override at lines 257-259):

```typescript
    protected buildUserMessage(input: CoachAgentInput, ctx: StrategistPipelineContext): string {
        return buildCoachMessage(input.analysis, ctx, input.constraintBlock);
    }
```

- [ ] **Step 6: Widen `executeCoachAgent`** (modify the wrapper at lines 343-348):

```typescript
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
    constraintBlock?: string,
): Promise<AgentResult<InterviewCoachResult>> {
    return coachAgent.execute({ analysis, constraintBlock }, ctx);
}
```

- [ ] **Step 7: Write a test that `parseResponse` accepts present AND absent phone-screen fields.** Create `applications/job-strategist/src/agents/coach-agent.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { CoachAgent } from './coach-agent.js';
import type { CoachAgentInput } from './coach-agent.js';
import type { StrategistPipelineContext } from '@bedrock/shared';

// parseResponse is protected — subclass to expose it for the test.
class TestableCoach extends CoachAgent {
    public parse(text: string, ctx: StrategistPipelineContext) {
        // @ts-expect-error access protected for test
        return this.parseResponse(text, {} as CoachAgentInput, ctx);
    }
}

const CTX = { interviewStage: 'phone-screen' } as unknown as StrategistPipelineContext;

const BASE = {
    stageDescription: 'd', technicalQuestions: [], behaviouralQuestions: [],
    difficultQuestions: [], technicalPrepChecklist: [], questionsToAsk: [], coachingNotes: 'n',
};

describe('CoachAgent.parseResponse', () => {
    it('accepts a payload WITHOUT the optional phone-screen fields', () => {
        const r = new TestableCoach().parse(JSON.stringify(BASE), CTX);
        expect(r.stage).toBe('phone-screen');
        expect(r.careerArcSummary).toBeUndefined();
    });
    it('accepts a payload WITH the phone-screen fields', () => {
        const payload = {
            ...BASE,
            careerArcSummary: 'Career arc...',
            jdTalkingPoints: [{ point: 'p', evidence: 'e' }],
            compScript: { targetEcho: 't', marketContext: null, deflectTemplate: 'd' },
        };
        const r = new TestableCoach().parse(JSON.stringify(payload), CTX);
        expect(r.careerArcSummary).toBe('Career arc...');
        expect(r.jdTalkingPoints?.[0]).toEqual({ point: 'p', evidence: 'e' });
        expect(r.compScript?.marketContext).toBeNull();
    });
});
```

> Note: `parseJsonResponse` unwraps forced-tool JSON. Passing a plain JSON object string is the unwrapped form — confirm `parseJsonResponse` accepts a bare JSON object; if it requires a tool-use envelope, wrap the payload as `{ input: <payload> }` per `parseJsonResponse`'s contract (read `@bedrock/shared` `parseJsonResponse` first). Adjust the test's serialised shape to match.

- [ ] **Step 8: Run the coach test**

Run: `cd applications/job-strategist && npx jest src/agents/coach-agent.test.ts`
Expected: PASS. (If the job-strategist package lacks a jest setup, see Task A6 Step 0 to confirm the test runner; if there is genuinely no jest here, move this test to `applications/shared` is NOT an option — instead confirm the runner and wire it. Report BLOCKED if no test runner exists.)

- [ ] **Step 9: Commit**

```bash
git add applications/job-strategist/src/agents/coach-agent.ts applications/job-strategist/src/agents/coach-agent.test.ts
git commit -m "feat(coach): optional phone-screen fields + constraint-block in user message (TDD)"
```

---

## Task A5: Persona prompt — instruct phone-screen field emission

**Files:**
- Modify: `applications/job-strategist/src/prompts/coach-persona.ts`

- [ ] **Step 1: Add an output-fields instruction.** Inside the `COACH_PERSONA_SYSTEM_PROMPT` text array, append these lines near the end of the cached text block (after the stage frameworks, before the closing of the `text` array). Insert verbatim:

```typescript
            ``,
            `════════════════════════════════════════════════════════════════════`,
            `        PHONE-SCREEN EXTRA OUTPUT FIELDS (stage = "phone-screen")`,
            `════════════════════════════════════════════════════════════════════`,
            ``,
            `When interview_stage is "phone-screen", ALSO emit these optional fields`,
            `in the coaching brief (omit them entirely for every other stage):`,
            `• careerArcSummary — a 2-3 sentence narrative of the candidate's trajectory,`,
            `  grounded in the analysis (experience signals, fit summary, verified work).`,
            `• jdTalkingPoints — the candidate's strongest VERIFIED matches cross-referenced`,
            `  against the job description; each {point, evidence} cites a real source.`,
            `• compScript — {targetEcho, marketContext, deflectTemplate} for the compensation`,
            `  question. Use the candidate's target and the market range from the stage-prep`,
            `  calibration block if present. If NO market range is provided, set marketContext`,
            `  to null and do NOT invent figures.`,
            `Use the "Stage-prep calibration" block in the user message as structural guidance.`,
```

- [ ] **Step 2: Smoke-assert the constant mentions the fields.** Create `applications/job-strategist/src/prompts/coach-persona.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { COACH_PERSONA_SYSTEM_PROMPT } from './coach-persona.js';

describe('COACH_PERSONA_SYSTEM_PROMPT', () => {
    it('instructs the phone-screen extra fields', () => {
        const text = COACH_PERSONA_SYSTEM_PROMPT.map(b => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('careerArcSummary');
        expect(text).toContain('jdTalkingPoints');
        expect(text).toContain('compScript');
        expect(text).toContain('do NOT invent');
    });
});
```

- [ ] **Step 3: Run + commit**

Run: `cd applications/job-strategist && npx jest src/prompts/coach-persona.test.ts` → PASS

```bash
git add applications/job-strategist/src/prompts/coach-persona.ts applications/job-strategist/src/prompts/coach-persona.test.ts
git commit -m "feat(coach): persona instruction for phone-screen output fields"
```

---

## Task A6: Parse `COMPENSATION_TARGET` + `REGION` env (TDD)

**Files:**
- Modify: `applications/job-strategist/src/env-coach.ts`
- Test: `applications/job-strategist/src/env-coach.test.ts`

- [ ] **Step 0: Confirm the test runner.** Run `cat applications/job-strategist/package.json` and note the `"test"` script. Run tests with that runner (assume `npx jest <path>` below; adjust if it differs). If the package has no test runner at all, report BLOCKED — do not invent one.

- [ ] **Step 1: Write the failing test** `applications/job-strategist/src/env-coach.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { parseCoachEnv } from './env-coach.js';

const REQUIRED = {
    COACH_PIPELINE_RUN_ID: 'c', STRATEGIST_PIPELINE_RUN_ID: 's', APPLICATION_ID: 'a',
    APPLICATION_SLUG: 'slug', USER_ID: 'u', TARGET_COMPANY: 'Acme', TARGET_ROLE: 'Senior Backend',
    JOB_DESCRIPTION: 'jd', INTERVIEW_STAGE: 'phone-screen',
    PG_HOST: 'h', PG_DATABASE: 'd', PG_USER: 'pu', PG_PASSWORD: 'pw',
};

describe('parseCoachEnv', () => {
    beforeEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.startsWith('PG_') || REQUIRED[k as keyof typeof REQUIRED] !== undefined ||
                k === 'COMPENSATION_TARGET' || k === 'REGION') delete process.env[k];
        }
        Object.assign(process.env, REQUIRED);
    });

    it('defaults region to eu-remote and compTarget to null', () => {
        const env = parseCoachEnv();
        expect(env.region).toBe('eu-remote');
        expect(env.compTarget).toBeNull();
    });

    it('parses COMPENSATION_TARGET and REGION when present', () => {
        process.env.COMPENSATION_TARGET = '95000';
        process.env.REGION = 'uk';
        const env = parseCoachEnv();
        expect(env.compTarget).toBe('95000');
        expect(env.region).toBe('uk');
    });
});
```

- [ ] **Step 2: Run — expect FAIL** (`region`/`compTarget` not on `CoachEnv`).

Run: `cd applications/job-strategist && npx jest src/env-coach.test.ts`
Expected: FAIL (type error / undefined).

- [ ] **Step 3: Add the fields.** In `env-coach.ts`, add to the `CoachEnv` interface (after `interviewStage`):

```typescript
    readonly compTarget:              string | null;
    readonly region:                  string;
```

And in `parseCoachEnv`'s returned object (after `interviewStage: required('INTERVIEW_STAGE'),`):

```typescript
        compTarget:              process.env['COMPENSATION_TARGET']?.trim() || null,
        region:                  process.env['REGION']?.trim() || 'eu-remote',
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd applications/job-strategist && npx jest src/env-coach.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/env-coach.ts applications/job-strategist/src/env-coach.test.ts
git commit -m "feat(coach): parse COMPENSATION_TARGET + REGION env (TDD)"
```

---

## Task A7: Wire `run-coach` — load research, build constraints, pass to coach

**Files:**
- Modify: `applications/job-strategist/src/run-coach.ts`

- [ ] **Step 1: Add a `research` loader + imports.** At the top imports, add:

```typescript
import type { StrategistResearchResult } from '@bedrock/shared';
import {
    RdsStagePrepOntologyRepository, toRoleFamily, toCompSeniority,
    loadStagePrepConstraints, buildStagePrepConstraintBlock,
} from '@bedrock/shared';
```

Add this loader next to `loadAnalysis` (it reads the SAME row's `research` key; returns null when absent so we degrade gracefully):

```typescript
async function loadResearch(pool: Pool, strategistPipelineRunId: string): Promise<StrategistResearchResult | null> {
    const result = await pool.query<{ metadata: { research?: StrategistResearchResult } | null }>(
        `SELECT metadata FROM pipeline_runs WHERE id = $1`,
        [strategistPipelineRunId],
    );
    return result.rows[0]?.metadata?.research ?? null;
}
```

- [ ] **Step 2: Build the constraint block before running the coach.** In `main()`, AFTER `const analysis = await loadAnalysis(...)` (line 67) and BEFORE `executeCoachAgent` (line 92), insert:

```typescript
        const research = await loadResearch(pool, env.strategistPipelineRunId);

        // Stage-prep ontology calibration (phone-screen and other supported stages).
        const repo = new RdsStagePrepOntologyRepository(pool);
        const seniority = toCompSeniority((research?.seniority ?? '').toLowerCase());
        const constraints = await loadStagePrepConstraints(repo, {
            targetCompany: env.targetCompany,
            roleFamily:    toRoleFamily(env.targetRole),
            stage:         env.interviewStage,
            seniority,
            region:        env.region,
            compTarget:    env.compTarget,
        });
        const constraintBlock = buildStagePrepConstraintBlock(constraints);
```

- [ ] **Step 3: Pass the block into the coach.** Change line 92:

```typescript
        const coaching = await executeCoachAgent(ctx, analysis, constraintBlock);
```

- [ ] **Step 4: Typecheck the package.**

Run: `cd applications/job-strategist && npx tsc --noEmit`
Expected: clean. (`research` is intentionally fetched for selector inputs; if tsc flags it unused because seniority is the only consumer, that's fine — it IS consumed by `toCompSeniority`.)

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/run-coach.ts
git commit -m "feat(coach): inject stage-prep constraints into coach run"
```

---

## Task A8: PART A full build/test gate

**Files:** none (verification only)

- [ ] **Step 1: Build/test shared**

Run: `cd applications/shared && npx tsc --noEmit && npx jest`
Expected: tsc clean; full suite green (includes Spec-1 + new constraint-block tests).

- [ ] **Step 2: Build/test job-strategist**

Run: `cd applications/job-strategist && npx tsc --noEmit && npx jest`
Expected: tsc clean; coach-agent / coach-persona / env-coach tests green. If the package has no jest config, run only `npx tsc --noEmit` and note that unit tests live where the runner exists; report what ran.

- [ ] **Step 2b: Build the shared dist if job-strategist consumes the built package** (worktree/CI parity): if `@bedrock/shared` is consumed as a built `dist`, run its build (`cd applications/shared && npm run build` or the repo's workspace build) so `loadStagePrepConstraints`/`buildStagePrepConstraintBlock` resolve at runtime. Confirm the import path resolves.

- [ ] **Step 3: Open the PART A PR** (after Spec 1 / PR #108 is merged to develop, rebase onto develop first):

```bash
git push -u origin <part-a-branch>
gh pr create --base develop --title "feat(coach): phone-screen prep generation (Spec 2a, ai-applications)" --body "Extends Coach Agent with optional phone-screen fields (careerArcSummary, jdTalkingPoints, compScript) grounded in the Spec-1 stage-prep ontology. Constraint block injected into the coach user message; fields ride in coaching_content.topics_to_study. Depends on #108. UI render is the tucaken-app PR (Spec 2a PART B)."
```

---

## PART B File Structure (`tucaken-app`)

| File | Responsibility | Action |
|---|---|---|
| `admin-api/src/routes/applications.ts` | `POST /:slug/coach` accepts + forwards `compensationTarget` + `region` | Modify |
| `src/lib/types/applications.types.ts` | Add 3 optional fields to `InterviewPrepOutput` | Modify |
| `src/features/applications/stages/workspaces/PhoneScreenWorkspace.tsx` | Render career arc / talking points / comp script | Modify |
| (coach dispatch call site) | Send `compTarget` + `region` in the `/coach` POST body | Modify |

> PART B works in the `tucaken-app` repo. Read each file before editing — the exact line numbers below are from a 2026-06-01 survey and may drift.

---

## Task B1: admin-api forwards comp target + region

**Files:**
- Modify: `admin-api/src/routes/applications.ts` (`POST /:slug/coach`, lines 286-385)

- [ ] **Step 1: Accept the two optional body fields.** In the `body` type (lines 292-300), add:

```typescript
      compensationTarget?:      string | number;
      region?:                  string;
```

- [ ] **Step 2: Normalise them (do NOT add to the required loop).** After `const mode = body.mode?.trim() || 'standard';` (line 315), add:

```typescript
    const compensationTarget =
      body.compensationTarget != null ? String(body.compensationTarget).trim() : '';
    const region = body.region?.trim() || 'eu-remote';
```

- [ ] **Step 3: Forward as env vars.** In the `env` array (lines 356-367), after the `MODE` entry, add:

```typescript
          ...(compensationTarget ? [{ name: 'COMPENSATION_TARGET', value: compensationTarget }] : []),
          { name: 'REGION', value: region },
```

- [ ] **Step 4: Test the forwarding.** Add/extend an admin-api test for `/coach` asserting that when `compensationTarget` + `region` are in the body, the built job env contains `COMPENSATION_TARGET` + `REGION`, and that `COMPENSATION_TARGET` is omitted when absent. Locate the existing applications route test (search `routes/applications` under `admin-api/**/*.test.ts`); if `buildPipelineJob` is mocked there, assert on its call args. If no such test harness exists, add a focused unit test around the env-assembly by extracting the env array into a small pure helper `buildCoachEnv({...})` and testing that.

Run the admin-api test suite (check `admin-api/package.json` `test` script).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-api/src/routes/applications.ts <test file>
git commit -m "feat(admin-api): forward compensationTarget + region to coach job"
```

---

## Task B2: Extend the UI `InterviewPrepOutput` type

**Files:**
- Modify: `src/lib/types/applications.types.ts` (`InterviewPrepOutput`, ~lines 324-341)

- [ ] **Step 1: Add the mirror types + optional fields.** Add near `InterviewPrepOutput`:

```typescript
export interface PhoneScreenTalkingPoint {
  readonly point: string
  readonly evidence: string
}

export interface CompScript {
  readonly targetEcho: string
  readonly marketContext: string | null
  readonly deflectTemplate: string
}
```

Add to `InterviewPrepOutput` (after `questionsToAsk` / `coachingNotes`):

```typescript
  readonly careerArcSummary?: string
  readonly jdTalkingPoints?: readonly PhoneScreenTalkingPoint[]
  readonly compScript?: CompScript
```

- [ ] **Step 2: Typecheck**

Run: `cd <tucaken-app root> && npx tsc --noEmit` (or the repo's typecheck script)
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types/applications.types.ts
git commit -m "feat(types): phone-screen prep fields on InterviewPrepOutput"
```

---

## Task B3: Render the new fields in `PhoneScreenWorkspace`

**Files:**
- Modify: `src/features/applications/stages/workspaces/PhoneScreenWorkspace.tsx`

> Read the file first. The existing accessors (from the 2026-06-01 survey): talking points come from `detail.research?.verifiedMatches[].skill` (~lines 57-59); coaching from `resolveStagePrep(detail)` → `InterviewPrepOutput` (~line 61); coaching notes at ~line 146; comp target input at ~lines 129-133.

- [ ] **Step 1: Resolve the phone-screen prep object.** Where the workspace already derives the per-stage coaching (the `resolveStagePrep(detail)` result, call it `prep`), read the three new fields: `prep?.careerArcSummary`, `prep?.jdTalkingPoints`, `prep?.compScript`.

- [ ] **Step 2: Career arc section.** Add a new section above "Your talking points" that renders `prep?.careerArcSummary` when present (plain paragraph). Omit the section entirely when absent.

- [ ] **Step 3: Talking points — prefer synthesized, fall back to raw skills.** Replace the raw `verifiedMatches[].skill` bullet list (lines ~57-59) with: if `prep?.jdTalkingPoints?.length`, render each as `point` (bold) + `evidence` (muted); else fall back to the existing `verifiedMatches[].skill` list. This keeps the workspace useful before the coach has emitted the new fields.

- [ ] **Step 4: Comp Conversation card.** In the comp card (lines ~115-139), when `prep?.compScript` is present render: `targetEcho`, the `marketContext` line ONLY when non-null, and `deflectTemplate`. Keep the existing user `compTarget` input. When `compScript` is absent, keep the current card as-is.

- [ ] **Step 5: Verify in the running app** (the spec's behaviour can't be unit-tested meaningfully at the workspace level). Use the project's run/verify path: load an application whose `coaching['phone-screen'].topics` includes the new fields and confirm the three sections render; load one without them and confirm graceful fallback. If component tests exist for workspaces, add a render test asserting career-arc text shows when provided and the talking-points fallback works when `jdTalkingPoints` is undefined.

- [ ] **Step 6: Commit**

```bash
git add src/features/applications/stages/workspaces/PhoneScreenWorkspace.tsx
git commit -m "feat(ui): render career arc, JD talking points, comp script in phone screen"
```

---

## Task B4: Send `compTarget` + `region` on coach dispatch

**Files:**
- Modify: the coach-dispatch call site (search `'/coach'` or `coach` mutation under `src/hooks/**` and `src/features/applications/**`)

- [ ] **Step 1: Locate the POST to `/:slug/coach`.** It currently sends `strategistPipelineRunId, interviewStage, applicationId, targetCompany, targetRole, jobDescription, mode`.

- [ ] **Step 2: Add the two fields to the request body.** Source `compensationTarget` from the Phone Screen draft's `compTarget` (the `useStageDraft` value already in the workspace; thread it to the dispatch call or read from the same draft hook). Source `region` from a constant default `'eu-remote'` (or a user/profile region if one is readily available — default otherwise). Send:

```typescript
      compensationTarget: compTarget || undefined,
      region: 'eu-remote',
```

- [ ] **Step 3: Typecheck + verify** the dispatch compiles and the network payload includes the new fields (devtools or a mocked mutation test if one exists).

- [ ] **Step 4: Commit**

```bash
git add <dispatch file>
git commit -m "feat(ui): send comp target + region when dispatching the coach"
```

- [ ] **Step 5: Open the PART B PR**

```bash
git push -u origin <part-b-branch>
gh pr create --base <tucaken-app default> --title "feat: phone screen prep rendering (Spec 2a, tucaken-app)" --body "Renders career arc / JD talking points / comp script from coaching_content; admin-api forwards compTarget + region to the coach job. Depends on the ai-applications Spec 2a PR."
```

---

## Self-review notes (for the executor)

- **Cross-package import:** `loadStagePrepConstraints`/`buildStagePrepConstraintBlock`/`RdsStagePrepOntologyRepository`/`toRoleFamily`/`toCompSeniority` must all be exported from `@bedrock/shared` root. Spec 1 added `RdsStagePrepOntologyRepository` + the stage-prep barrel; Task A2 Step 5 adds the constraint-block exports. Verify the import in A7 resolves before wiring.
- **Degradation:** every ontology lookup is null-safe; `research` null → `seniority` defaults to `'mid'` (via `toCompSeniority('')`), constraint block still renders the truthfulness reminder; the coach emits the optional fields from `analysisXml` alone.
- **No `coaching_content` migration** — the fields ride in `topics_to_study`. Do not add one.
- **Phone-screen gating** is by persona instruction, not code — other stages simply won't emit the optional fields, and Zod `.optional()` lets that validate.

## Out of scope (Spec 2b)
- `interview_stages.user_state`, PATCH endpoint, UI localStorage→RDS migration, `/advance` flow.
