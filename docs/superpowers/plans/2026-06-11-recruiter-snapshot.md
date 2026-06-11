# Recruiter Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a tailored resume is generated, produce a recruiter snapshot — a hybrid 0–100 match score, top-5 missing keywords, and 3 red flags — surfaced in a new app panel.

**Architecture:** A new post-ATS step in `run-pipeline` computes a deterministic baseline score from real signals (ATS keyword coverage + research verified/gaps + hard-req hits), then a cheap Haiku forced-tool agent nudges the score ±10 and selects grounded keywords/flags. Result is fail-open and stashed on `pipeline_runs.metadata.analysis.recruiterSnapshot`. admin-api surfaces it; a new React panel renders it.

**Tech Stack:** TypeScript, Zod, AWS Bedrock (`runAgent`, Haiku forced-tool), Jest (ai-applications) / Vitest (tucaken UI), React 19 + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-06-11-recruiter-snapshot-design.md`

---

## File structure

**ai-applications** (branch `feat/recruiter-snapshot`, off `develop`)
- `applications/job-strategist/src/agents/recruiter-snapshot.ts` — schema, `computeBaselineScore` (pure), `buildRecruiterSnapshot` (agent). One responsibility: produce the snapshot.
- `applications/job-strategist/src/agents/recruiter-snapshot.test.ts` — unit tests.
- `applications/job-strategist/src/run-pipeline.ts` — wire the call + add to metadata stash (modify).

**tucaken-app** (branch `feat/recruiter-snapshot`, off `main`)
- `admin-api/src/routes/applications.ts` — map `recruiterSnapshot` into the analysis response (modify).
- `src/lib/types/applications.types.ts` — `RecruiterSnapshot`/`RecruiterRedFlag` types + add to `AnalysisOutput` (modify).
- `src/features/applications/stages/components/RecruiterSnapshotPanel.tsx` — the panel (new).
- `src/features/applications/stages/components/RecruiterSnapshotPanel.test.tsx` — panel test (new).
- `src/features/applications/stages/workspaces/AppliedWorkspace.tsx` — render the panel (modify).

---

## Task 1: Schema + baseline scoring (pure function)

**Files:**
- Create: `applications/job-strategist/src/agents/recruiter-snapshot.ts`
- Test: `applications/job-strategist/src/agents/recruiter-snapshot.test.ts`

- [ ] **Step 1: Write the failing test for the baseline math**

Create `applications/job-strategist/src/agents/recruiter-snapshot.test.ts`:

```ts
/** @format */
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult } from '@bedrock/shared';
import { computeBaselineScore } from './recruiter-snapshot.js';

function ats(present: number, total: number): AtsCheckResult {
    const cov = Array.from({ length: total }, (_, i) => ({ term: `k${i}`, present: i < present, grounded: false }));
    return {
        machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
        parseBreakers: [], jdKeywordCoverage: cov, status: 'passed', passed: true, issues: [],
    };
}
function research(verified: string[], gaps: string[], hardReqs: string[]): Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'> {
    return {
        verifiedMatches: verified.map((skill) => ({ skill, sourceCitation: '', depth: 'deep', recency: '' })),
        gaps:            gaps.map((skill) => ({ skill, gapType: 'missing', impactSeverity: 'high', disqualifyingAssessment: '' })),
        hardRequirements: hardReqs.map((skill) => ({ skill, context: '' })),
    } as Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>;
}

describe('computeBaselineScore', () => {
    it('weights coverage 0.5, verified-ratio 0.3, hard-req-hit 0.2', () => {
        // coverage 6/10=0.6 ; verified 6/(6+4)=0.6 ; hardReqHit: 1 of 2 in verified = 0.5
        const r = research(['AWS', 'K8s', 'a', 'b', 'c', 'd'], ['g1', 'g2', 'g3', 'g4'], ['AWS', 'Terraform']);
        // 100*(0.5*0.6 + 0.3*0.6 + 0.2*0.5) = 100*(0.30+0.18+0.10) = 58
        expect(computeBaselineScore(r, ats(6, 10))).toBe(58);
    });

    it('hard-req-hit is 1 when there are no hard requirements', () => {
        const r = research(['x'], [], []);
        // coverage 1 ; verified 1/1=1 ; hardReqHit 1 → 100
        expect(computeBaselineScore(r, ats(4, 4))).toBe(100);
    });

    it('returns 0 when nothing matches', () => {
        const r = research([], ['g1'], ['AWS']);
        expect(computeBaselineScore(r, ats(0, 5))).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test recruiter-snapshot`
Expected: FAIL — `computeBaselineScore is not a function` / module not found.

- [ ] **Step 3: Create the module with schema + baseline**

Create `applications/job-strategist/src/agents/recruiter-snapshot.ts`:

```ts
/** @format */
import { z } from 'zod';
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult } from '@bedrock/shared';

export const RecruiterRedFlagSchema = z.object({
    flag: z.string(),
    why:  z.string(),
});

export const RecruiterSnapshotSchema = z.object({
    score:           z.number().int().min(0).max(100),
    scoreRationale:  z.string(),
    missingKeywords: z.array(z.string()).max(5),
    redFlags:        z.array(RecruiterRedFlagSchema).max(3),
});

export type RecruiterSnapshot = z.infer<typeof RecruiterSnapshotSchema>;

/** Weights for the deterministic baseline (sum to 1). Tunable in one place. */
const W_COVERAGE = 0.5;
const W_VERIFIED = 0.3;
const W_HARDREQ  = 0.2;

/**
 * Deterministic 0–100 baseline from real signals: ATS keyword coverage, the
 * verified-vs-gap ratio, and how many hard requirements are evidenced.
 */
export function computeBaselineScore(
    research: Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>,
    atsCheck: AtsCheckResult,
): number {
    const cov = atsCheck.jdKeywordCoverage;
    const keywordCoverage = cov.length === 0 ? 0 : cov.filter((k) => k.present).length / cov.length;

    const v = research.verifiedMatches.length;
    const g = research.gaps.length;
    const verifiedRatio = v + g === 0 ? 0 : v / (v + g);

    const hardReqs = research.hardRequirements;
    const verifiedSkills = new Set(research.verifiedMatches.map((m) => m.skill.toLowerCase()));
    const hardReqHit = hardReqs.length === 0
        ? 1
        : hardReqs.filter((r) => verifiedSkills.has(r.skill.toLowerCase())).length / hardReqs.length;

    return Math.round(100 * (W_COVERAGE * keywordCoverage + W_VERIFIED * verifiedRatio + W_HARDREQ * hardReqHit));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test recruiter-snapshot`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/agents/recruiter-snapshot.ts applications/job-strategist/src/agents/recruiter-snapshot.test.ts
git commit -m "feat(strategist): recruiter-snapshot schema + baseline scoring"
```

---

## Task 2: buildRecruiterSnapshot agent (Haiku, grounded, fail-open)

> **Grounding note (refines the spec):** red flags are grounded in `research.gaps`
> (each carries `gapType`, `impactSeverity`, `disqualifyingAssessment` — the substance
> of a red flag) rather than the analysis XML's `red_flags_and_ambiguities`. The
> snapshot function takes `(ctx, research, atsCheck)` and the analysis isn't a
> structured input here; `research.gaps` is already the grounded, structured source.
> Missing keywords ground in the ATS `not present` terms, as specced.

**Files:**
- Modify: `applications/job-strategist/src/agents/recruiter-snapshot.ts`
- Test: `applications/job-strategist/src/agents/recruiter-snapshot.test.ts`

- [ ] **Step 1: Write failing tests for assembly + fail-open**

Append to `recruiter-snapshot.test.ts`. Mock `runAgent` from `@bedrock/shared`:

```ts
import { jest } from '@jest/globals';

jest.unstable_mockModule('@bedrock/shared', () => ({
    runAgent: jest.fn(),
    log: () => undefined,
}));

const { runAgent } = await import('@bedrock/shared');
const { buildRecruiterSnapshot } = await import('./recruiter-snapshot.js');

const CTX = { pipelineId: 'p', environment: 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 } as never;
const RESEARCH = research(['AWS'], ['Kafka'], ['AWS']) as never; // helper from Task 1

describe('buildRecruiterSnapshot', () => {
    it('applies the LLM delta to the baseline (clamped) and passes through keywords/flags', async () => {
        (runAgent as jest.Mock).mockResolvedValue({
            data: { scoreDelta: 8, scoreRationale: 'strong infra fit', missingKeywords: ['Kafka', 'gRPC'], redFlags: [{ flag: 'No streaming', why: 'JD centres on Kafka' }] },
        });
        const snap = await buildRecruiterSnapshot(CTX, RESEARCH, ats(2, 4)); // baseline: cov .5, ver 1/2=.5, hardReqHit 1 → 100*(.25+.15+.2)=60
        expect(snap?.score).toBe(68);                       // 60 + 8
        expect(snap?.missingKeywords).toEqual(['Kafka', 'gRPC']);
        expect(snap?.redFlags[0].flag).toBe('No streaming');
    });

    it('clamps to 100', async () => {
        (runAgent as jest.Mock).mockResolvedValue({ data: { scoreDelta: 10, scoreRationale: 'x', missingKeywords: [], redFlags: [] } });
        const snap = await buildRecruiterSnapshot(CTX, research(['a'], [], []) as never, ats(4, 4)); // baseline 100
        expect(snap?.score).toBe(100);
    });

    it('returns null when atsCheck is null (fail-open)', async () => {
        expect(await buildRecruiterSnapshot(CTX, RESEARCH, null)).toBeNull();
    });

    it('returns null when the agent throws (fail-open)', async () => {
        (runAgent as jest.Mock).mockRejectedValue(new Error('bedrock down'));
        expect(await buildRecruiterSnapshot(CTX, RESEARCH, ats(2, 4))).toBeNull();
    });
});
```

NOTE: convert the existing Task-1 `describe` file to ESM-mock form — move the `ats`/`research` helpers above the mocks so both blocks use them, and import `computeBaselineScore` from the dynamic `await import('./recruiter-snapshot.js')` alongside `buildRecruiterSnapshot`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test recruiter-snapshot`
Expected: FAIL — `buildRecruiterSnapshot is not a function`.

- [ ] **Step 3: Implement the agent**

Append to `applications/job-strategist/src/agents/recruiter-snapshot.ts`:

```ts
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const MODEL_ID = process.env['JD_EXTRACTOR_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Haiku tool output: a bounded score nudge + grounded selections. */
const NudgeSchema = z.object({
    scoreDelta:      z.number().int().min(-10).max(10),
    scoreRationale:  z.string(),
    missingKeywords: z.array(z.string()).max(5).default([]),
    redFlags:        z.array(RecruiterRedFlagSchema).max(3).default([]),
});
type Nudge = z.infer<typeof NudgeSchema>;

const TOOL = {
    name: 'emit_recruiter_snapshot',
    description: 'Emit a bounded score adjustment and the grounded keyword/flag selections.',
    input_schema: {
        type: 'object',
        properties: {
            scoreDelta:      { type: 'integer', minimum: -10, maximum: 10, description: 'Adjustment to the baseline score, [-10,10].' },
            scoreRationale:  { type: 'string', description: 'One line explaining the score.' },
            missingKeywords: { type: 'array', items: { type: 'string' }, description: 'Up to 5 most impactful missing JD keywords.' },
            redFlags:        { type: 'array', items: { type: 'object', properties: { flag: { type: 'string' }, why: { type: 'string' } }, required: ['flag', 'why'], additionalProperties: false }, description: 'Up to 3 red flags a recruiter notices in 10 seconds.' },
        },
        required: ['scoreDelta', 'scoreRationale', 'missingKeywords', 'redFlags'],
        additionalProperties: false,
    },
} as const;

const SYSTEM_PROMPT = [
    'You are a hiring manager doing a 10-second read of a tailored resume against a job description.',
    'Call emit_recruiter_snapshot. Rules:',
    '- scoreDelta: adjust the given baseline by at most ±10 based on overall impression; explain in scoreRationale (one line).',
    '- missingKeywords: pick the up-to-5 MOST IMPACTFUL JD terms not yet covered, ONLY from the provided candidate list. Never invent terms.',
    '- redFlags: pick the up-to-3 sharpest concerns, ONLY from the provided gaps/concerns. Phrase each as {flag, why} a recruiter would actually say. Never invent.',
].join('\n');

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

/**
 * Produce the recruiter snapshot. FAIL-OPEN: returns null when atsCheck is null
 * or the agent errors, so the pipeline never fails because of it.
 */
export async function buildRecruiterSnapshot(
    ctx: BasePipelineContext,
    research: Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>,
    atsCheck: AtsCheckResult | null,
): Promise<RecruiterSnapshot | null> {
    if (!atsCheck) return null;

    const baseline = computeBaselineScore(research, atsCheck);
    const missingCandidates = atsCheck.jdKeywordCoverage.filter((k) => !k.present).map((k) => k.term);
    const gapLines = research.gaps.map((g) => `${g.skill} [${g.gapType}/${g.impactSeverity}] ${g.disqualifyingAssessment}`.trim());

    const userMessage = [
        `<baseline_score>${baseline}</baseline_score>`,
        `<missing_keyword_candidates>${missingCandidates.join(', ') || '(none)'}</missing_keyword_candidates>`,
        `<gaps_and_concerns>`,
        ...(gapLines.length ? gapLines.map((l) => `- ${l}`) : ['(none)']),
        `</gaps_and_concerns>`,
    ].join('\n');

    const config: AgentConfig = {
        agentName:      'recruiter-snapshot',
        modelId:        MODEL_ID,
        maxTokens:      1024,
        thinkingBudget: 0,
        systemPrompt:   [{ text: SYSTEM_PROMPT }],
        pipeline:       'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    try {
        const result = await runAgent<Nudge>({
            config,
            userMessage,
            pipelineContext: ctx,
            parseResponse: (s) => {
                const parsed = NudgeSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`recruiter-snapshot: schema validation failed: ${parsed.error.message}`);
                return parsed.data;
            },
        });
        const n: Nudge = result.data;
        const snapshot: RecruiterSnapshot = {
            score:           clamp(baseline + n.scoreDelta, 0, 100),
            scoreRationale:  n.scoreRationale,
            missingKeywords: n.missingKeywords.slice(0, 5),
            redFlags:        n.redFlags.slice(0, 3),
        };
        log('INFO', 'Recruiter snapshot built', { agent: 'recruiter-snapshot', score: snapshot.score, baseline });
        return snapshot;
    } catch (e) {
        log('WARN', 'Recruiter snapshot failed (non-fatal)', { agent: 'recruiter-snapshot', error: (e as Error).message });
        return null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test recruiter-snapshot`
Expected: PASS (all baseline + agent tests).

- [ ] **Step 5: Typecheck**

Run: `cd applications/job-strategist && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 6: Commit**

```bash
git add applications/job-strategist/src/agents/recruiter-snapshot.ts applications/job-strategist/src/agents/recruiter-snapshot.test.ts
git commit -m "feat(strategist): buildRecruiterSnapshot Haiku agent (grounded, fail-open)"
```

---

## Task 3: Wire into run-pipeline + metadata stash

**Files:**
- Modify: `applications/job-strategist/src/run-pipeline.ts`

- [ ] **Step 1: Add the import**

Near the other agent imports (after the `renderCheckAndStoreAts` import), add:

```ts
import { buildRecruiterSnapshot } from './agents/recruiter-snapshot.js';
```

- [ ] **Step 2: Build the snapshot after the ATS step**

Find the block that captures `atsCheck` (added by the ATS-RLS work):

```ts
        let atsCheck: AtsCheckResult | null = null;
        if (persisted && tailoredResumeData) {
            atsCheck = await renderCheckAndStoreAts({ /* … */ });
        }
```

Immediately after that block, add:

```ts
        // Recruiter snapshot — hybrid score + grounded missing-keywords/red-flags.
        // Fail-open (null on any error); needs the ATS keyword coverage, so it runs here.
        const recruiterSnapshot = await buildRecruiterSnapshot(ctx, research.data, atsCheck).catch(() => null);
```

- [ ] **Step 3: Add to the metadata stash**

Find the `updatePipelineRunMetadata` call and add `recruiterSnapshot` to the `analysis` object:

```ts
        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            analysis:     { ...analysis.data, analysisXml: finalAnalysis, pathGrounding, atsCheck, recruiterSnapshot },
            research:     research.data,
            jdExtraction,
        });
```

- [ ] **Step 4: Typecheck + full suite**

Run: `cd applications/job-strategist && npx tsc --noEmit && yarn test`
Expected: tsc clean; all suites pass.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/run-pipeline.ts
git commit -m "feat(strategist): wire recruiter snapshot into run-pipeline metadata"
```

- [ ] **Step 6: Open the ai-applications PR**

```bash
git push -u origin feat/recruiter-snapshot
```
Open PR `feat/recruiter-snapshot` → `develop` (via gh or github MCP). Title: `feat(strategist): recruiter snapshot (hybrid score + missing keywords + red flags)`.

---

## Task 4: admin-api mapping

**Files:**
- Modify: `admin-api/src/routes/applications.ts` (tucaken-app)

Branch off `main`: `git switch -c feat/recruiter-snapshot origin/main` (in tucaken-app).

- [ ] **Step 1: Write the failing mapping test**

In the admin-api applications route test (the suite asserting the analysis shape — search `atsCheck` in `admin-api/src/routes/applications.test.ts` or `__tests__/routes/applications.test.ts`), add a case: when `pipeline_runs.metadata.analysis.recruiterSnapshot` is set, the response `analysis.recruiterSnapshot` equals it; when absent, it is `null`. Mirror the existing `atsCheck`/`jdExtraction` assertions exactly (same mock fixture, add `recruiterSnapshot` to the metadata `analysis` blob).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd admin-api && yarn test applications`
Expected: FAIL — response has no `recruiterSnapshot` key.

- [ ] **Step 3: Add the mapping**

In `admin-api/src/routes/applications.ts`, in the `analysis = rawAnalysis ? { … }` object (next to `atsCheck`), add:

```ts
        // Recruiter snapshot (metadata.analysis.recruiterSnapshot) — hybrid score + missing keywords + red flags.
        recruiterSnapshot: rawAnalysis['recruiterSnapshot'] ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd admin-api && yarn test applications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-api/src/routes/applications.ts admin-api/src/routes/applications.test.ts
git commit -m "feat(admin-api): surface recruiterSnapshot in the analysis response"
```

---

## Task 5: UI types + panel

**Files:**
- Modify: `src/lib/types/applications.types.ts`
- Create: `src/features/applications/stages/components/RecruiterSnapshotPanel.tsx`
- Create: `src/features/applications/stages/components/RecruiterSnapshotPanel.test.tsx`
- Modify: `src/features/applications/stages/workspaces/AppliedWorkspace.tsx`

- [ ] **Step 1: Add the types**

In `src/lib/types/applications.types.ts`, near `AtsCheckResult`, add:

```ts
export interface RecruiterRedFlag {
  readonly flag: string
  readonly why: string
}

export interface RecruiterSnapshot {
  readonly score: number
  readonly scoreRationale: string
  readonly missingKeywords: readonly string[]
  readonly redFlags: readonly RecruiterRedFlag[]
}
```

In the `AnalysisOutput` interface (where `atsCheck?: AtsCheckResult | null` is), add:

```ts
  readonly recruiterSnapshot?: RecruiterSnapshot | null
```

- [ ] **Step 2: Write the failing panel test**

Create `src/features/applications/stages/components/RecruiterSnapshotPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RecruiterSnapshotPanel } from './RecruiterSnapshotPanel'

const SNAP = {
  score: 45,
  scoreRationale: 'Stretch — infra strong, product-eng thin.',
  missingKeywords: ['Kafka', 'gRPC', 'Go'],
  redFlags: [{ flag: 'No streaming experience', why: 'JD centres on Kafka pipelines' }],
}

describe('RecruiterSnapshotPanel', () => {
  it('renders the score, keywords, and red flags', () => {
    render(<RecruiterSnapshotPanel snapshot={SNAP} />)
    expect(screen.getByText('45')).toBeInTheDocument()
    expect(screen.getByText('Kafka')).toBeInTheDocument()
    expect(screen.getByText('No streaming experience')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn test RecruiterSnapshotPanel`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the panel**

Create `src/features/applications/stages/components/RecruiterSnapshotPanel.tsx`. Follow the existing panel conventions (`AtsPanel.tsx`, `JdUnderstandingPanel.tsx`): `rounded-md`, `border`, dark-mode classes, chips for keywords. No nested ternaries (extract a `scoreBand` helper):

```tsx
import { AlertTriangle } from 'lucide-react'
import type { RecruiterSnapshot } from '@/lib/types/applications.types'

function scoreBand(score: number): { ring: string; text: string; label: string } {
  if (score >= 70) return { ring: 'text-emerald-600 dark:text-emerald-400', text: 'text-emerald-700 dark:text-emerald-300', label: 'Strong match' }
  if (score >= 50) return { ring: 'text-amber-600 dark:text-amber-400', text: 'text-amber-700 dark:text-amber-300', label: 'Partial match' }
  return { ring: 'text-rose-600 dark:text-rose-400', text: 'text-rose-700 dark:text-rose-300', label: 'Stretch' }
}

export function RecruiterSnapshotPanel({ snapshot }: { readonly snapshot: RecruiterSnapshot }) {
  const band = scoreBand(snapshot.score)
  return (
    <section className="space-y-4 rounded-md border border-zinc-200 bg-zinc-50/50 p-5 dark:border-white/10 dark:bg-white/2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recruiter snapshot</h3>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">10-second read</span>
      </div>

      <div className="flex items-center gap-4">
        <div className={`text-4xl font-semibold tabular-nums ${band.ring}`}>{snapshot.score}<span className="text-base text-zinc-400">/100</span></div>
        <div>
          <p className={`text-sm font-medium ${band.text}`}>{band.label}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{snapshot.scoreRationale}</p>
        </div>
      </div>

      {snapshot.missingKeywords.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Top missing keywords</p>
          <div className="flex flex-wrap gap-1.5">
            {snapshot.missingKeywords.map((kw) => (
              <span key={kw} className="rounded-md border border-rose-300 px-2 py-0.5 text-xs text-rose-600 dark:border-rose-500/30 dark:text-rose-400">{kw}</span>
            ))}
          </div>
        </div>
      )}

      {snapshot.redFlags.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Red flags · 10-second read</p>
          <ul className="space-y-1.5">
            {snapshot.redFlags.map((rf) => (
              <li key={rf.flag} className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span><span className="font-medium">{rf.flag}</span> — <span className="text-zinc-500 dark:text-zinc-400">{rf.why}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test RecruiterSnapshotPanel`
Expected: PASS.

- [ ] **Step 6: Render it in AppliedWorkspace**

In `src/features/applications/stages/workspaces/AppliedWorkspace.tsx`, near `const atsCheck = detail.analysis?.atsCheck`, add:

```tsx
  const recruiterSnapshot = detail.analysis?.recruiterSnapshot
```

And in the JSX, above the ATS panel line (`{atsCheck ? <AtsPanel ats={atsCheck} /> : null}`), add:

```tsx
      {recruiterSnapshot ? <RecruiterSnapshotPanel snapshot={recruiterSnapshot} /> : null}
```

Add the import at the top: `import { RecruiterSnapshotPanel } from '../components/RecruiterSnapshotPanel'`.

- [ ] **Step 7: Typecheck + lint + tests**

Run: `yarn typecheck && yarn lint && yarn test RecruiterSnapshotPanel applications`
Expected: clean; tests pass.

- [ ] **Step 8: Commit + PR**

```bash
git add src/lib/types/applications.types.ts src/features/applications/stages/components/RecruiterSnapshotPanel.tsx src/features/applications/stages/components/RecruiterSnapshotPanel.test.tsx src/features/applications/stages/workspaces/AppliedWorkspace.tsx
git commit -m "feat(applications): RecruiterSnapshotPanel (score + missing keywords + red flags)"
git push -u origin feat/recruiter-snapshot
```
Open PR `feat/recruiter-snapshot` → `main` (tucaken). Title: `feat(applications): recruiter snapshot panel`. Note in body: deploy after the ai-applications PR (which writes the metadata).

---

## Deploy order

1. ai-applications PR → `develop` → build → SSM → job-strategist (writes `recruiterSnapshot`).
2. tucaken PR → `main` → admin-api (ArgoCD) + UI.
3. Re-run a JB → the panel renders.
