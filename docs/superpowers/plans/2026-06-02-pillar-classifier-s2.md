# JD Pillar Classifier (S2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify a JD's interview-prep focus (multi-label, JD-evidence-grounded) and surface it as a "Role focus" chip + "matches this role" markers in the Technical workspace.

**Architecture:** Add an optional `pillarClassification` field to the research agent's forced-tool output (3 schema places; passthrough is automatic via `validateResearchResult`'s spread). admin-api passes it through `normaliseResearch`; the workspace renders a label-only chip + section markers. No migration; no hide/reorder.

**Tech Stack:** TypeScript, Bedrock forced-tool + Zod, Hono (admin-api), React + TanStack, Jest/Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-pillar-classifier-s2-design.md`

**Branches:** PR1 `feat/pillar-classifier-s2` (ai-applications, off develop — created). PR2 a new branch off tucaken-app `main` (has merged DSA+DevOps sections).

---

## File Structure
- **PR1 (ai-applications):**
  - Modify `applications/job-strategist/src/agents/research-agent.ts` — schema (2 places) + prompt block.
  - Modify `applications/shared/src/strategist-types.ts` — `StrategistResearchResult.pillarClassification?`.
  - Test `applications/job-strategist/src/agents/research-agent.test.ts` (or nearest existing) — `validateResearchResult`.
- **PR2 (tucaken-app):**
  - Modify `admin-api/src/routes/applications.ts` — `normaliseResearch` passthrough.
  - Modify `admin-api/__tests__/routes/applications.test.ts`.
  - Modify `src/lib/types/applications.types.ts` — `PillarClassification` + `ResearchOutput.pillarClassification`.
  - Modify `src/features/applications/stages/workspaces/TechnicalWorkspace.tsx` — chip + markers.
  - Modify `src/__tests__/features/applications/stage-components.test.tsx`.

---

## Task 1: research agent `pillarClassification` (ai-applications)

**Files:**
- Modify: `applications/job-strategist/src/agents/research-agent.ts`
- Modify: `applications/shared/src/strategist-types.ts`
- Test: `applications/job-strategist/src/agents/research-agent.test.ts`

- [ ] **Step 1: Write failing tests** for `validateResearchResult` (pure, exported). Find the existing research-agent test file; add:

```typescript
import { validateResearchResult } from './research-agent.js';

const BASE = {
  targetRole: 'SRE', targetCompany: 'Acme', seniority: 'senior', domain: 'infra',
  hardRequirements: [], softRequirements: [], implicitRequirements: [],
  technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
  experienceSignals: { yearsExpected: '5', domainExperience: 'x', leadershipExpectation: 'y', scaleIndicators: 'z' },
  verifiedMatches: [], partialMatches: [], gaps: [],
  overallFitRating: 'STRONG FIT', fitSummary: 'ok',
};
const INJECTED = { resumeData: null, kbContext: '', resumeConstraints: '' };

it('accepts a brief WITHOUT pillarClassification (optional)', () => {
  const r = validateResearchResult(BASE, INJECTED);
  expect(r.pillarClassification).toBeUndefined();
});

it('passes pillarClassification through when present', () => {
  const r = validateResearchResult({
    ...BASE,
    pillarClassification: {
      primaryPillar: 'devops-sre-platform', secondaryPillars: ['ai-engineering'],
      confidence: 0.8, jdEvidenceTokens: ['on-call rotation', 'Kubernetes'], classificationNote: 'inferred from JD',
    },
  }, INJECTED);
  expect(r.pillarClassification?.primaryPillar).toBe('devops-sre-platform');
  expect(r.pillarClassification?.secondaryPillars).toEqual(['ai-engineering']);
});

it('rejects an invalid primaryPillar enum', () => {
  expect(() => validateResearchResult({
    ...BASE,
    pillarClassification: { primaryPillar: 'wizardry', secondaryPillars: [], confidence: 1, jdEvidenceTokens: [], classificationNote: 'x' },
  }, INJECTED)).toThrow(/schema validation/);
});
```

- [ ] **Step 2: Run, verify fail.** `npm test -w applications/job-strategist -- research-agent` → FAIL.

- [ ] **Step 3a: Add the tool-schema property** in `research-agent.ts` `RESEARCH_TOOL.inputSchema.properties`, immediately after the `fitSummary: { type: 'string' }` line (do NOT add to the `required` array):

```typescript
            pillarClassification: {
                type: 'object',
                properties: {
                    primaryPillar: { type: 'string', enum: ['swe-general','swe-dsa','devops-sre-platform','ai-engineering'] },
                    secondaryPillars: { type: 'array', items: { type: 'string', enum: ['swe-general','swe-dsa','devops-sre-platform','ai-engineering'] } },
                    confidence: { type: 'number' },
                    jdEvidenceTokens: STR_ARRAY,
                    classificationNote: { type: 'string' },
                },
                required: ['primaryPillar','secondaryPillars','confidence','jdEvidenceTokens','classificationNote'],
            },
```

- [ ] **Step 3b: Add the Zod field** to `ResearchModelSchema` (before the closing `}).strict();`), `.optional()`:

```typescript
    pillarClassification: z.object({
        primaryPillar: z.enum(['swe-general','swe-dsa','devops-sre-platform','ai-engineering']),
        secondaryPillars: z.array(z.enum(['swe-general','swe-dsa','devops-sre-platform','ai-engineering'])),
        confidence: z.number(),
        jdEvidenceTokens: z.array(z.string()),
        classificationNote: z.string(),
    }).strict().optional(),
```

- [ ] **Step 3c: Add the type** to `StrategistResearchResult` in `applications/shared/src/strategist-types.ts`, before the injected fields (`resumeData`), so the spread in `validateResearchResult` types correctly:

```typescript
    /** JD interview-prep pillar classification (inferred from JD language; optional). */
    readonly pillarClassification?: {
        readonly primaryPillar: 'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering';
        readonly secondaryPillars: ReadonlyArray<'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering'>;
        readonly confidence: number;
        readonly jdEvidenceTokens: string[];
        readonly classificationNote: string;
    };
```

- [ ] **Step 3d: Add the prompt instruction.** In `buildUserMessage` (research-agent.ts ~line 283), append a section to `sections` before the `return`:

```typescript
    sections.push(
        '## Interview-prep pillar classification',
        'Classify the role\'s interview-prep focus from the JOB DESCRIPTION LANGUAGE ONLY and emit it as `pillarClassification`.',
        '- primaryPillar = "swe-general" UNLESS the JD clearly emphasizes one of:',
        '  • "swe-dsa" — algorithms/data-structures/LeetCode/coding-interview/complexity',
        '  • "devops-sre-platform" — Kubernetes/Terraform/cloud/SRE/on-call/incident/SLO/reliability/platform',
        '  • "ai-engineering" — LLM/RAG/embeddings/vector/prompt/evals/fine-tune/agent/MCP/inference',
        '- secondaryPillars: every OTHER pillar the JD also applies to (multi-label; [] if none).',
        '- jdEvidenceTokens: the VERBATIM JD phrases that drove the choice (≥1 when primaryPillar≠"swe-general").',
        '- classificationNote: one line stating this is inferred from JD language, not guaranteed.',
        '',
    );
```

- [ ] **Step 4: Run, verify pass.** `npm test -w applications/job-strategist -- research-agent` → PASS. Typecheck: `npm run build -w applications/shared && npx tsc --noEmit -p applications/job-strategist` (or repo equivalent) → clean.

- [ ] **Step 5: Commit**

```bash
git add applications/job-strategist/src/agents/research-agent.ts applications/shared/src/strategist-types.ts applications/job-strategist/src/agents/research-agent.test.ts
git commit -m "feat(research): pillarClassification — multi-label JD interview-prep focus (optional, JD-evidence-grounded)"
```

---

## Task 2: admin-api passthrough (tucaken-app)

**Branch:** `git checkout main && git pull --ff-only && git checkout -b feat/pillar-classifier-s2-ui`

**Files:**
- Modify: `admin-api/src/routes/applications.ts` (`normaliseResearch`)
- Test: `admin-api/__tests__/routes/applications.test.ts`

- [ ] **Step 1 (read first):** Read `normaliseResearch` in `applications.ts`. Note the existing `dsaTopicCalibration` passthrough block (`if (raw['dsaTopicCalibration'] !== undefined) { result['dsaTopicCalibration'] = raw['dsaTopicCalibration']; }`) — mirror it.

- [ ] **Step 2: Write the failing test** in `applications.test.ts` (find the `normaliseResearch`/GET :slug research test; add an assertion or a focused test):

```typescript
it('passes pillarClassification through verbatim when present', async () => {
  pgGetApplicationMock.mockResolvedValue(APPLICATION_ROW);
  poolQueryMock
    .mockResolvedValueOnce({ rows: [{ id: 'run-1', metadata: { research: {
      fitSummary: 'x', overallFitRating: 'STRONG FIT', verifiedMatches: [], gaps: [],
      pillarClassification: { primaryPillar: 'devops-sre-platform', secondaryPillars: [], confidence: 0.8, jdEvidenceTokens: ['Kubernetes'], classificationNote: 'inferred' },
    } }, created_at: new Date() }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  const res = await buildApp().request('/app-uuid-1');
  const body = (await res.json()) as { application: { research: Record<string, unknown> } };
  expect(body.application.research.pillarClassification).toEqual({
    primaryPillar: 'devops-sre-platform', secondaryPillars: [], confidence: 0.8, jdEvidenceTokens: ['Kubernetes'], classificationNote: 'inferred',
  });
});
```
(Adjust the mocked `db.query` call ordering to match the handler's actual sequence — read the test file's other GET :slug cases for the count.)

- [ ] **Step 3: Run, verify fail.** `cd admin-api && npm test -- applications.test` → FAIL.

- [ ] **Step 4: Implement** — in `normaliseResearch`, after the `dsaTopicCalibration` passthrough block, add:

```typescript
  // Pass pillarClassification through verbatim when present (S2).
  if (raw['pillarClassification'] !== undefined) {
    result['pillarClassification'] = raw['pillarClassification'];
  }
```

- [ ] **Step 5: Run, verify pass.** `cd admin-api && npm test -- applications.test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/routes/applications.ts admin-api/__tests__/routes/applications.test.ts
git commit -m "feat(admin-api): pass pillarClassification through normaliseResearch"
```

---

## Task 3: UI Role-focus chip + section markers (tucaken-app)

**Files:**
- Modify: `src/lib/types/applications.types.ts`
- Modify: `src/features/applications/stages/workspaces/TechnicalWorkspace.tsx`
- Test: `src/__tests__/features/applications/stage-components.test.tsx`

- [ ] **Step 1: Add UI type** in `applications.types.ts` (near the existing `DsaTopicCalibration`), and add `pillarClassification?` to the `ResearchOutput` interface:

```typescript
export type Pillar = 'swe-general' | 'swe-dsa' | 'devops-sre-platform' | 'ai-engineering';
export interface PillarClassification {
  readonly primaryPillar: Pillar;
  readonly secondaryPillars: Pillar[];
  readonly confidence: number;
  readonly jdEvidenceTokens: string[];
  readonly classificationNote: string;
}
// on ResearchOutput:
  readonly pillarClassification?: PillarClassification;
```

- [ ] **Step 2: Write failing tests** (extend `stage-components.test.tsx`; reuse the file's existing `TechnicalWorkspace` render helper):

```typescript
it('renders the Role focus chip with primary + secondary labels for a non-general pillar', () => {
  const detail = makeDetail({ research: { pillarClassification: {
    primaryPillar: 'devops-sre-platform', secondaryPillars: ['ai-engineering'],
    confidence: 0.8, jdEvidenceTokens: ['on-call', 'Kubernetes'], classificationNote: 'inferred from JD',
  } } });
  render(<TechnicalWorkspace detail={detail} />);
  expect(screen.getByText(/Role focus/i)).toBeInTheDocument();
  expect(screen.getByText(/DevOps \/ Platform/)).toBeInTheDocument();
  expect(screen.getByText(/AI Engineering/)).toBeInTheDocument();
});

it('shows NO Role focus chip for swe-general', () => {
  const detail = makeDetail({ research: { pillarClassification: {
    primaryPillar: 'swe-general', secondaryPillars: [], confidence: 0.5, jdEvidenceTokens: [], classificationNote: 'general',
  } } });
  render(<TechnicalWorkspace detail={detail} />);
  expect(screen.queryByText(/Role focus/i)).not.toBeInTheDocument();
});

it('shows NO Role focus chip when pillarClassification absent', () => {
  render(<TechnicalWorkspace detail={makeDetail({ research: {} })} />);
  expect(screen.queryByText(/Role focus/i)).not.toBeInTheDocument();
});
```
(Adapt `makeDetail`/render to the file's actual helpers.)

- [ ] **Step 3: Implement** in `TechnicalWorkspace.tsx`:
  - Add constants near the top:
```tsx
const PILLAR_LABEL: Record<string, string> = {
  'swe-general': 'General Software', 'swe-dsa': 'Algorithms / DSA',
  'devops-sre-platform': 'DevOps / Platform', 'ai-engineering': 'AI Engineering',
}
```
  - At the top of the returned JSX (before the first section), render the chip when present and non-general:
```tsx
{(() => {
  const pc = detail.research?.pillarClassification
  if (!pc || pc.primaryPillar === 'swe-general') return null
  const pillars = [pc.primaryPillar, ...pc.secondaryPillars]
  return (
    <Card className="space-y-1.5 border-accent/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Role focus</span>
        {pillars.map(p => (
          <span key={p} className="inline-flex rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent ring-1 ring-inset ring-accent/20">
            {PILLAR_LABEL[p] ?? p}
          </span>
        ))}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Inferred from the JD{pc.jdEvidenceTokens.length > 0 ? `: "${pc.jdEvidenceTokens.join('", "')}"` : ''}. {pc.classificationNote}
      </p>
    </Card>
  )
})()}
```
  - **"Matches this role" markers:** compute `const focusPillars = new Set([...(detail.research?.pillarClassification ? [detail.research.pillarClassification.primaryPillar, ...detail.research.pillarClassification.secondaryPillars] : [])])`. On the **DSA section** heading (the existing Section B), when `focusPillars.has('swe-dsa')`, render a small `<span>` badge "Matches this role". On the **DevOps section** heading (Section C), when `focusPillars.has('devops-sre-platform')`. Use the same badge styling as the chip pills. Do NOT change the sections' existing show/hide gates.

- [ ] **Step 4: Run, verify pass.** `npm test -- stage-components` → PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types/applications.types.ts src/features/applications/stages/workspaces/TechnicalWorkspace.tsx src/__tests__/features/applications/stage-components.test.tsx
git commit -m "feat(ui): Role focus chip + matches-this-role section markers (pillar classifier)"
```

---

## Final
- [ ] PR1: `npm test -w applications/job-strategist` + `npm test -w applications/shared` green; push `feat/pillar-classifier-s2`, open PR (base develop).
- [ ] PR2: full UI + admin-api suites green; push `feat/pillar-classifier-s2-ui`, open PR (base main; depends on PR1 producing the field).
- [ ] Final code-reviewer (focus: optional-everywhere/fail-open; jdEvidenceTokens required for non-general; chip hidden for swe-general + absent; NO section hide/reorder; enum parity across schema/Zod/TS).
- [ ] superpowers:finishing-a-development-branch. PR bodies: no migration; the UI surfaces nothing until PR1 deploys + a fresh analysis runs (classification is per-analysis, not backfilled).

## Out of scope (S2)
- AI pillar section (S4); round_type gating (S5); coach pillar-awareness; any section hide/reorder.
