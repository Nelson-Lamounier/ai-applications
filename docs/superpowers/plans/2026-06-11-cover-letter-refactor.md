# Cover-letter Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Stop the cover letter undoing the resume — fix the title, kill self-rejection/arguing, align to the resume's positioning + years framing, tighten format — via a persona rewrite + a deterministic guard with a Haiku rewrite-on-violation.

**Architecture:** `cover-letter-guard.ts` (deterministic `validateCoverLetter` + Haiku `rewriteCoverLetter` + `guardCoverLetter` orchestrator, fail-open), wired into run-pipeline to replace the raw cover letter before persistence; plus rewritten persona cover-letter + positioning-headline rules.

**Tech Stack:** TypeScript (NodeNext ESM, `.js`), Zod, Bedrock Haiku (`runAgent`), Jest (ts-jest CJS).

**Spec:** `docs/superpowers/specs/2026-06-11-cover-letter-refactor-design.md`. Branch `feat/cover-letter-refactor` (off `feat/years-gap`). Build shared with `cd applications/shared && npx tsc --build`.

---

## Task 1: validateCoverLetter (deterministic)

**Files:** Create `applications/job-strategist/src/agents/cover-letter-guard.ts` + `.test.ts`.

- [ ] **Step 1: Failing tests** — `cover-letter-guard.test.ts`:
```ts
/** @format */
import { validateCoverLetter } from './cover-letter-guard.js';

const codes = (l: string, target = 'AI Support Engineer', lead = 'User Operations Engineer') =>
    validateCoverLetter(l, target, lead).map((v) => v.code);

describe('validateCoverLetter', () => {
    it('flags missing JD title', () => {
        expect(codes('I am excited about the User Operations Engineer role at OpenAI.')).toContain('missing_title');
    });
    it('flags using the lead-identity as the role name', () => {
        expect(codes('Applying for the User Operations Engineer role; I am an AI Support Engineer fit.')).toContain('wrong_title');
    });
    it('flags self-rejection / gap-naming / arguing phrases', () => {
        expect(codes('My 3 years falls short of the 8-year threshold for AI Support Engineer.')).toContain('names_gap');
        expect(codes('I do not yet have direct hands-on experience with the API (AI Support Engineer).')).toContain('names_gap');
        expect(codes('I would be surprised if many candidates match this. AI Support Engineer.')).toContain('names_gap');
    });
    it('flags too much bold', () => {
        const many = '**a** **b** **c** **d** **e** AI Support Engineer';
        expect(codes(many)).toContain('too_bold');
    });
    it('flags unrealised impact', () => {
        expect(codes('The system is pending security review. AI Support Engineer.')).toContain('unrealised_impact');
    });
    it('clean letter → no violations', () => {
        expect(codes('I build production AI support systems. The AI Support Engineer role at OpenAI fits exactly. **OpenAI**.')).toEqual([]);
    });
});
```
Run `cd applications/job-strategist && yarn test cover-letter-guard` → FAIL.

- [ ] **Step 2: Implement** the validator in `cover-letter-guard.ts`:
```ts
/** @format */

export interface CoverLetterViolation { code: string; detail: string; }

const GAP_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
    { code: 'names_gap', re: /falls?\s+short/i },
    { code: 'names_gap', re: /do(?:es)?\s*n['’]?t\s+yet\s+have|do not yet have|have not yet|lack(?:ing)?\s+(?:direct\s+|hands-on\s+)?experience/i },
    { code: 'names_gap', re: /\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)/i },
    { code: 'names_gap', re: /I would be surprised/i },
    { code: 'names_gap', re: /while I (?:do\s*n['’]?t|do not|have\s*n['’]?t|lack)/i },
];
const UNREALISED = /pending (?:security )?review|not yet (?:shipped|deployed|in production)|once (?:approved|shipped)/i;
const MAX_BOLD = 4;

/** Deterministic cover-letter checks. */
export function validateCoverLetter(letter: string, targetRole: string, leadIdentity: string): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const lower = letter.toLowerCase();

    if (targetRole && !lower.includes(targetRole.toLowerCase())) {
        out.push({ code: 'missing_title', detail: `Body never names the target role "${targetRole}".` });
    }
    if (leadIdentity && leadIdentity.toLowerCase() !== targetRole.toLowerCase()) {
        const li = leadIdentity.toLowerCase();
        if (lower.includes(`${li} role`) || lower.includes(`${li} position`)) {
            out.push({ code: 'wrong_title', detail: `Body uses the positioning identity "${leadIdentity}" as the role name.` });
        }
    }
    for (const { code, re } of GAP_PATTERNS) {
        if (re.test(letter)) { out.push({ code, detail: `Matched self-rejection/arguing pattern: ${re}` }); break; }
    }
    const boldCount = (letter.match(/\*\*[^*]+\*\*/g) ?? []).length;
    if (boldCount > MAX_BOLD) out.push({ code: 'too_bold', detail: `${boldCount} bold spans (max ${MAX_BOLD}).` });
    if (UNREALISED.test(letter)) out.push({ code: 'unrealised_impact', detail: 'Claims not-yet-realised impact.' });

    return out;
}
```

- [ ] **Step 3:** `yarn test cover-letter-guard` → PASS; `npx tsc --noEmit` → clean. Commit:
```bash
git add applications/job-strategist/src/agents/cover-letter-guard.ts applications/job-strategist/src/agents/cover-letter-guard.test.ts
git commit -m "feat(strategist): deterministic cover-letter validator"
```

---

## Task 2: Haiku rewrite + guard orchestrator

**Files:** Modify `cover-letter-guard.ts` + `.test.ts`; add `'cover-letter-rewrite'` to `AgentName` in `applications/shared/src/types.ts`.

- [ ] **Step 1: Failing tests** (append; mock `@bedrock/shared`):
```ts
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { guardCoverLetter } from './cover-letter-guard.js';
const mockRun = runAgent as jest.Mock;

describe('guardCoverLetter', () => {
    it('null/empty letter → passthrough, no rewrite call', async () => {
        const r = await guardCoverLetter(null, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toBeNull();
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('clean letter → unchanged, no rewrite call', async () => {
        const clean = 'I build production AI support. The AI Support Engineer role at OpenAI fits. **OpenAI**.';
        const r = await guardCoverLetter(clean, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toBe(clean);
        expect(r.violations).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });
    it('violations → calls rewrite and returns the rewritten letter + the original violations', async () => {
        mockRun.mockResolvedValue({ data: { letter: 'Fixed letter naming AI Support Engineer.' } });
        const bad = 'My 3 years falls short of the 8-year threshold.';
        const r = await guardCoverLetter(bad, 'AI Support Engineer', 'User Operations Engineer', '5 years across support');
        expect(r.letter).toBe('Fixed letter naming AI Support Engineer.');
        expect(r.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['missing_title', 'names_gap']));
    });
    it('rewrite throws → returns the ORIGINAL letter (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const bad = 'My 3 years falls short of the threshold.';
        const r = await guardCoverLetter(bad, 'AI Support Engineer', 'User Operations Engineer', '');
        expect(r.letter).toBe(bad);
    });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** — add to `cover-letter-guard.ts`:
```ts
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const MODEL_ID = process.env['COVER_LETTER_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const RewriteSchema = z.object({ letter: z.string() });
const TOOL = {
    name: 'emit_cover_letter',
    description: 'Return the corrected cover letter.',
    input_schema: { type: 'object', properties: { letter: { type: 'string' } }, required: ['letter'], additionalProperties: false },
} as const;
const CTX: BasePipelineContext = { pipelineId: 'cover-letter-guard', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteCoverLetter(
    letter: string,
    violations: CoverLetterViolation[],
    ctx: { targetRole: string; leadIdentity: string; yearsGapFraming: string },
): Promise<string> {
    const system = [
        'You repair a cover letter, fixing ONLY the listed issues. Call emit_cover_letter.',
        'Rules:',
        `- Name the position EXACTLY as "${ctx.targetRole}" — never as "${ctx.leadIdentity}" or a team name.`,
        '- Remove every sentence that names, apologises for, or argues against a gap or missing experience. Do not replace them — delete them.',
        ctx.yearsGapFraming ? `- Where tenure is mentioned, use this true framing instead: "${ctx.yearsGapFraming}".` : '- Do not state a single-role tenure that undersells the candidate.',
        '- Keep bold to at most 4 spans. Remove claims of not-yet-realised impact (e.g. "pending review").',
        '- Do NOT invent any new factual claim. Preserve the real evidence and voice; only cut/repair the flagged problems.',
    ].join('\n');
    const config: AgentConfig = {
        agentName: 'cover-letter-rewrite', modelId: MODEL_ID, maxTokens: 1500, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<letter>${letter}</letter>`;
    try {
        const result = await runAgent<{ letter: string }>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const v = RewriteSchema.safeParse(JSON.parse(s));
                if (!v.success) throw new Error(`cover-letter-rewrite: ${v.error.message}`);
                return v.data;
            },
        });
        return result.data.letter.trim() || letter;
    } catch (e) {
        log('WARN', 'cover-letter rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return letter;
    }
}

/** Validate → rewrite on violation → return. Never throws. */
export async function guardCoverLetter(
    letter: string | null,
    targetRole: string,
    leadIdentity: string,
    yearsGapFraming: string,
): Promise<{ letter: string | null; violations: CoverLetterViolation[] }> {
    if (!letter || letter.trim().length === 0) return { letter, violations: [] };
    const violations = validateCoverLetter(letter, targetRole, leadIdentity);
    if (violations.length === 0) return { letter, violations };
    const fixed = await rewriteCoverLetter(letter, violations, { targetRole, leadIdentity, yearsGapFraming });
    return { letter: fixed, violations };
}
```
Add `'cover-letter-rewrite'` to `AgentName` in `applications/shared/src/types.ts`; `cd applications/shared && npx tsc --build`.

- [ ] **Step 3:** `yarn test cover-letter-guard` → PASS; `npx tsc --noEmit` → clean. Commit:
```bash
git add applications/job-strategist/src/agents/cover-letter-guard.ts applications/job-strategist/src/agents/cover-letter-guard.test.ts applications/shared/src/types.ts
git commit -m "feat(strategist): cover-letter Haiku rewrite + guard orchestrator (fail-open)"
```

---

## Task 3: persona cover-letter + positioning-headline rewrite

**Files:** Modify `applications/job-strategist/src/prompts/strategist-persona.ts` + a presence test.

- [ ] **Step 1:** Find the `<cover_letter>` CDATA block (grep `cover_letter`). Replace its rules so they instruct (keep the structural greeting/sign-off but REPLACE the guidance):
  - name the position with the exact Target Role verbatim — never the archetype lead identity or team name;
  - lead the first paragraph with a concrete hook / the positioning differentiator (not a windup), and reflect the YEARS GAP FRAMING relevant-experience framing; never open with an underselling single-role tenure;
  - never name, apologise for, or argue against any gap — OMIT gaps entirely (omission is not dishonesty; never fabricate);
  - surface the JD's exact requirement vocabulary where a verified match supports it (translate real work into the JD's words, never claim unsupported);
  - 3 tight paragraphs; bold ≤ 4 spans (company + 1–2 strongest quals); only realised/shipped impact (no "pending review").
- [ ] **Step 2:** Find where the persona sets `profile.title` to the archetype lead identity (grep `profile.title` / `lead identity`). Add a rule: the lead identity / `profile.title` MUST be a **positioning headline** of the form `<target-aligned role> · <domain breadth>` (e.g. "Technical Support Engineer · Cloud & AI Operations") — a descriptive positioning, never a literal claim of holding the JD title.
- [ ] **Step 3:** Add a presence test `applications/job-strategist/src/prompts/strategist-persona.test.ts` (or extend an existing persona test): assert the joined persona string contains the key phrases — "exact Target Role", "OMIT gaps" (or the omission rule), "positioning headline", "at most 4" (bold cap). (A light guard that the rules didn't get dropped.)
- [ ] **Step 4:** `cd applications/job-strategist && npx tsc --noEmit && yarn test` → green. Commit:
```bash
git add applications/job-strategist/src/prompts/strategist-persona.ts applications/job-strategist/src/prompts/strategist-persona.test.ts
git commit -m "feat(strategist): rewrite cover-letter rules + positioning-headline rule"
```

---

## Task 4: wire the guard into run-pipeline

**Files:** Modify `applications/job-strategist/src/run-pipeline.ts`.

- [ ] **Step 1:** Import `guardCoverLetter`. Add a Prom Counter near the others:
```ts
const coverLetterViolations = new Counter({
    name: 'job_strategist_cover_letter_violations_total',
    help: 'Cover-letter guard violations caught (and rewritten) by code.',
    labelNames: ['code'] as const,
    registers: [obs.registry],
});
```
- [ ] **Step 2:** After `const analysis = await executeStrategistAgent(...)` (and where `research`, `yearsGap` are in scope), add:
```ts
        const { letter: finalCoverLetter, violations: coverViolations } = await guardCoverLetter(
            analysis.data.coverLetter,
            research.data.targetRole,
            analysis.data.archetypeSelection?.leadIdentity ?? '',
            yearsGap?.framingLine ?? '',
        );
        for (const v of coverViolations) coverLetterViolations.inc({ code: v.code });
```
- [ ] **Step 3:** Replace the cover letter in the persistence paths with `finalCoverLetter`:
  - the `updatePipelineRunMetadata` `analysis` object → add `coverLetter: finalCoverLetter` (so it OVERRIDES the spread `...analysis.data`'s coverLetter — place it AFTER the spread).
  - the `lintResumeProse(pool, env, tailoredResumeData, analysis.data.coverLetter)` call → pass `finalCoverLetter`.
  - any DynamoDB/record write that reads `analysis.data.coverLetter` → pass `finalCoverLetter` (grep `coverLetter` in run-pipeline + the persist helpers).
- [ ] **Step 4:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → all green (note pre-existing parse-back flake only). Commit + push:
```bash
git add applications/job-strategist/src/run-pipeline.ts
git commit -m "feat(strategist): guard the cover letter before persistence + violation metric"
git push -u origin feat/cover-letter-refactor
```

---

## Deploy + verify
1. Stacks on `feat/years-gap` → merge that first (or rebase onto develop once it lands).
2. ai-apps PR → `develop` → build → SSM → job-strategist.
3. Re-run the JB → the cover letter should: name "AI Support Engineer" (not "User Operations Engineer"), omit the 3-vs-8 self-rejection + the "I would be surprised" arguing, lead with the differentiator + the ~5-year framing, surface JD vocabulary, ≤4 bold spans; the `cover_letter_violations_total` metric shows what was caught.
