# Experience Bullet Discipline + JD-aware Optimisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap experience to 2-5 bullets per role (deterministic, both writers) and make the free writer JD-aware — give it the full JD it is scored on and have it optimise experience skills/tech/ATS wording to that JD, without fabrication or new LLM calls.

**Architecture:** A shared pure `capHighlights` truncates each role's highlights to 5 after parse (the deterministic guarantee), applied in both the free and paid parse paths; an advisory `maxItems` nudges the free model. A shared `jdAtsKeywords` helper becomes the single source of truth for the ATS keyword universe, fed to BOTH the free ATS check and the free writer's prompt. The free persona gains JD-relevance selection (Pillar A) and active ATS/skill/tech optimisation (Pillar B); the paid persona gains the per-role cap line. Both pillars are eval-covered.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Jest (`@jest/globals`), Bedrock via `runAgent`, Zod.

## Global Constraints

- **Deterministic cap = 5 per role** via post-parse truncation (keep the first 5; the persona orders by JD relevance). Floor of 2 is advisory (persona + grader warn) — never pad.
- **No new LLM call**; **no migration**.
- **Anti-hallucination holds:** Pillar B surfaces only JD terms the candidate's evidence supports; omission of an unsupported skill is correct, never fabricate to match a keyword.
- **ATS keyword union is one source of truth** — `jdAtsKeywords(jdSignal)` used by both the free ATS check and the writer prompt (no drift). The real union is `requiredSkills ∪ tools ∪ retrievalKeywords` (matches today's `run-free.ts` ATS check).
- English (UK); `applications/` complexity ceiling 10; ESLint + `yarn typecheck` clean (run from `applications/job-strategist`). Tests: `yarn test <path>`.
- Commit bodies as impact bullets; NO "Co-Authored-By: Claude" trailer. No `--no-verify` unless a hook is unrelated+broken (note it).
- **Branch:** `spec/experience-bullet-discipline` (stacked on #327).
- **Schema-bound decision:** add advisory `minItems:2, maxItems:5` to the FREE tool inputSchema only (the model sees it; the separate Zod parse schema is NOT bounded, so a stray >5 is truncated, not hard-rejected). Do NOT add a Zod `.max(5)` to the paid schema — it would hard-reject and trigger needless schema-repair churn; truncation + persona enforce paid. Truncation is the guarantee for both.

---

## File Structure

- **Create** `applications/job-strategist/src/agents/experience-cap.ts` — `capHighlights`.
- **Create** `applications/job-strategist/src/agents/experience-cap.test.ts`.
- **Create** `applications/job-strategist/src/ats/jd-keywords-union.ts` — `jdAtsKeywords`.
- **Create** `applications/job-strategist/src/ats/jd-keywords-union.test.ts`.
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.ts` — apply cap in `parseFreeResumeResponse`; advisory `minItems/maxItems` on the tool schema; grader >5 check; widen `buildUserMessage` (Pillar B).
- **Modify** `applications/job-strategist/src/free/run-free.ts` — use `jdAtsKeywords` for the ATS check (single source of truth).
- **Modify** `applications/job-strategist/src/agents/strategist-agent.ts` — apply cap after the tailored-resume parse.
- **Modify** `applications/job-strategist/src/prompts/free-resume-persona.ts` — Pillar A selection + Pillar B optimisation rules.
- **Modify** `applications/job-strategist/src/prompts/strategist-persona.ts` — per-role cap line.
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts` — Pillar A + Pillar B eval.

---

## Task 1: `capHighlights` shared helper

**Files:**
- Create: `applications/job-strategist/src/agents/experience-cap.ts`
- Test: `applications/job-strategist/src/agents/experience-cap.test.ts`

**Interfaces:**
- Produces: `capHighlights<T extends { highlights?: string[] }>(experience: readonly T[], max?: number): T[]` (default `max = 5`).

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { capHighlights } from './experience-cap.js';

describe('capHighlights', () => {
    it('truncates a role to the first `max` highlights (default 5)', () => {
        const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a','b','c','d','e','f','g','h'] }];
        const out = capHighlights(exp);
        expect(out[0].highlights).toEqual(['a','b','c','d','e','f','g','h'].slice(0, 5));
        expect(out[0].highlights).toHaveLength(5);
    });
    it('leaves a role with <= max highlights unchanged', () => {
        const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a','b','c'] }];
        expect(capHighlights(exp)[0].highlights).toEqual(['a','b','c']);
    });
    it('keeps relevance order (first N), not a reordering', () => {
        const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['1','2','3','4','5','6'] }];
        expect(capHighlights(exp, 3)[0].highlights).toEqual(['1','2','3']);
    });
    it('is safe when highlights is missing or empty', () => {
        expect(capHighlights([{ company: 'X', title: 't', period: 'p' } as never])[0].highlights).toEqual([]);
        expect(capHighlights([{ company: 'X', title: 't', period: 'p', highlights: [] }])[0].highlights).toEqual([]);
    });
    it('does not mutate the input array entries', () => {
        const exp = [{ company: 'X', title: 't', period: 'p', highlights: ['a','b','c','d','e','f'] }];
        capHighlights(exp);
        expect(exp[0].highlights).toHaveLength(6);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/experience-cap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * Per-role experience bullet cap — the deterministic guarantee that no
 * experience entry exceeds `max` highlights. The writer persona orders each
 * role's bullets by JD relevance, so keeping the FIRST `max` keeps the most
 * relevant. Pure + total: a role with <= max (or missing) highlights is
 * returned unchanged; never pads, never throws, never mutates the input.
 */
export function capHighlights<T extends { highlights?: string[] }>(
    experience: readonly T[],
    max = 5,
): T[] {
    return experience.map((e) => ({ ...e, highlights: (e.highlights ?? []).slice(0, max) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/agents/experience-cap.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/experience-cap.ts src/agents/experience-cap.test.ts
git add applications/job-strategist/src/agents/experience-cap.ts applications/job-strategist/src/agents/experience-cap.test.ts
git commit -m "feat(strategist): capHighlights — deterministic per-role bullet cap

Pure helper truncating each experience role to the first N highlights (default
5); the guarantee behind the experience bullet ceiling, shared by free + paid."
```

---

## Task 2: apply the cap + advisory bound + grader check (free path)

**Files:**
- Modify: `applications/job-strategist/src/agents/free-resume-writer.ts`
- Test: `applications/job-strategist/src/agents/free-resume-writer.test.ts`

**Interfaces:**
- Consumes: `capHighlights` (Task 1).
- Produces: `parseFreeResumeResponse` caps each role to 5; `gradeFreeResume` flags any role >5.

- [ ] **Step 1: Write failing tests**

Add to `free-resume-writer.test.ts` (reuse the file's existing `GOOD`/`EV` fixtures; build an 8-highlight role):

```typescript
import { capHighlights } from './experience-cap.js';

it('parseFreeResumeResponse caps each experience role to 5 highlights', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `Bullet ${i + 1} starts with a verb.`);
    // GOOD_JSON is the file's helper that serialises a FreeResumeOutput to the tool JSON shape;
    // if absent, build the minimal tool JSON inline with one experience role carrying `eight`.
    const json = toToolJson({ ...GOOD, resume: { ...GOOD.resume, experience: [{ company: 'Freelance', title: 'Eng', period: '2018-Now', highlights: eight }] } });
    const out = parseFreeResumeResponse(json);
    expect(out.resume.experience[0].highlights).toHaveLength(5);
    expect(out.resume.experience[0].highlights).toEqual(eight.slice(0, 5));
});

it('gradeFreeResume flags a role with more than 5 highlights', () => {
    const six = Array.from({ length: 6 }, (_, i) => `Did thing ${i + 1}.`);
    const bad = { ...GOOD, resume: { ...GOOD.resume, experience: [{ company: 'Freelance', title: 'Eng', period: 'p', highlights: six }] } } as never;
    expect(gradeFreeResume(bad, EV).failures.some((f) => /more than 5|exceeds 5|bullet/i.test(f))).toBe(true);
});
```

(Match the file's existing helper for producing tool JSON; if the tests construct `FreeResumeOutput` directly and call the grader, keep the grader test and for the parse test feed `parseFreeResumeResponse` a JSON string built the same way the other parse tests build theirs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts -t "caps each experience role|more than 5"`
Expected: FAIL — parse returns 8; grader has no count check.

- [ ] **Step 3: Implement**

In `free-resume-writer.ts`:
- Import: `import { capHighlights } from './experience-cap.js';`
- In `parseFreeResumeResponse`, cap before returning:

```typescript
export function parseFreeResumeResponse(text: string): FreeResumeOutput {
    const parsed = parseJsonResponse<unknown>(text, 'free-resume-writer');
    const validated = FreeResumeOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new Error(`free-resume-writer: schema validation failed: ${validated.error.message}`);
    }
    const data = validated.data as FreeResumeOutput;
    // Deterministic per-role bullet cap — independent of whether the model honoured maxItems.
    return { ...data, resume: { ...data.resume, experience: capHighlights(data.resume.experience) } };
}
```

- Advisory bound on the tool inputSchema `highlights` (the `:107` line):

```typescript
highlights: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
```

- In `gradeFreeResume`, add (keep the function flat):

```typescript
for (const e of out.resume.experience) {
    if (e.highlights.length > 5) {
        failures.push(`experience role "${e.company}" has more than 5 highlights (${e.highlights.length}) — cap to the 5 most JD-relevant`);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.ts src/agents/free-resume-writer.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.ts applications/job-strategist/src/agents/free-resume-writer.test.ts
git commit -m "feat(free-resume): cap experience to 5 bullets/role + grader check

Truncate each role's highlights to 5 in parse (deterministic), add advisory
minItems/maxItems to the tool schema, and flag any >5 role in the grader."
```

---

## Task 3: apply the cap (paid strategist path)

**Files:**
- Modify: `applications/job-strategist/src/agents/strategist-agent.ts`
- Test: `applications/job-strategist/src/agents/strategist-agent.test.ts`

**Interfaces:**
- Consumes: `capHighlights` (Task 1).
- Produces: the parsed tailored-resume's experience is capped to 5/role.

- [ ] **Step 1: Find the parse return + write a failing test**

Locate the function that parses `<tailored_resume_json>` (the CDATA pattern ~`strategist-agent.ts:614`, returning the `TailoredResumeSchema`-validated object with `experience`). In `strategist-agent.test.ts`, add a test that feeds that parser an XML payload whose one experience role has 7 highlights and asserts the returned `experience[0].highlights` has length 5 (first 5). Match how the file's existing strategist-parse tests construct the `<tailored_resume_json><![CDATA[ ... ]]>` input.

```typescript
import { capHighlights } from './experience-cap.js';
// (test calls the exported parse function — use its real name from the file, e.g. parseTailoredResume)
it('caps paid experience roles to 5 highlights', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `Bullet ${i + 1}`);
    const xml = buildTailoredXml({ experience: [{ company: 'Freelance', title: 'Eng', period: 'p', highlights: seven }] /* + other required fields */ });
    const parsed = parseTailoredResume(xml);
    expect(parsed.experience[0].highlights).toHaveLength(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts -t "caps paid experience"`
Expected: FAIL — returns 7.

- [ ] **Step 3: Implement**

In `strategist-agent.ts`: import `capHighlights` and apply it to the parsed experience before returning from the tailored-resume parser:

```typescript
import { capHighlights } from './experience-cap.js';
// ...inside the parse function, after the Zod validation succeeds:
return { ...data, experience: capHighlights(data.experience) };
```

Leave the Zod schema (`:569-573`) unchanged — do NOT add `.max(5)` (it would hard-reject and trigger schema-repair churn; truncation is the guarantee).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/strategist-agent.ts src/agents/strategist-agent.test.ts
git add applications/job-strategist/src/agents/strategist-agent.ts applications/job-strategist/src/agents/strategist-agent.test.ts
git commit -m "feat(strategist): cap paid experience to 5 bullets/role

Apply the shared capHighlights to the tailored-resume parse so the paid path
enforces the same deterministic per-role ceiling as free."
```

---

## Task 4: `jdAtsKeywords` shared helper + rewire the free ATS check

**Files:**
- Create: `applications/job-strategist/src/ats/jd-keywords-union.ts`
- Create: `applications/job-strategist/src/ats/jd-keywords-union.test.ts`
- Modify: `applications/job-strategist/src/free/run-free.ts`

**Interfaces:**
- Produces: `jdAtsKeywords(jd: Pick<JdSignal,'requiredSkills'|'tools'|'retrievalKeywords'>): string[]` — deduped, trimmed, non-empty union.

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { jdAtsKeywords } from './jd-keywords-union.js';

describe('jdAtsKeywords', () => {
    it('unions requiredSkills, tools, retrievalKeywords; dedupes and drops blanks', () => {
        const out = jdAtsKeywords({ requiredSkills: ['IAM', 'TypeScript'], tools: ['IAM', 'Terraform'], retrievalKeywords: ['terraform', '', '  '] });
        expect(out).toEqual(expect.arrayContaining(['IAM', 'TypeScript', 'Terraform', 'terraform']));
        expect(out.filter((k) => k === 'IAM')).toHaveLength(1);     // deduped
        expect(out.some((k) => k.trim() === '')).toBe(false);       // no blanks
    });
    it('returns [] when all fields are empty', () => {
        expect(jdAtsKeywords({ requiredSkills: [], tools: [], retrievalKeywords: [] })).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/ats/jd-keywords-union.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * The JD's ATS keyword universe — the single source of truth scored by the
 * grounded ATS check AND shown to the free writer, so it optimises for exactly
 * what it is measured on (no drift). Union of the JD's required skills, tools,
 * and retrieval keywords (deduped, trimmed, non-empty).
 */
import type { JdSignal } from '@bedrock/shared';

export function jdAtsKeywords(
    jd: Pick<JdSignal, 'requiredSkills' | 'tools' | 'retrievalKeywords'>,
): string[] {
    return Array.from(
        new Set([...jd.requiredSkills, ...jd.tools, ...jd.retrievalKeywords].map((s) => s.trim()).filter((s) => s.length > 0)),
    );
}
```

(Confirm `JdSignal` is exported from `@bedrock/shared`; if it is exported from `../agents/jd-extractor.js` instead, import it from there.)

- [ ] **Step 4: Rewire run-free + verify**

In `run-free.ts`, replace the inline union (the `const jdKeywords = [ ...requiredSkills, ...tools, ...retrievalKeywords ]` block ~`:164`) with:

```typescript
import { jdAtsKeywords } from '../ats/jd-keywords-union.js';
// ...
const jdKeywords = jdAtsKeywords(jdSignal);
```

Run: `cd applications/job-strategist && yarn test src/ats/jd-keywords-union.test.ts && yarn test src/free/ && yarn typecheck`
Expected: PASS; 0 type errors (run-free behaviour identical — same union, now shared).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/ats/jd-keywords-union.ts src/ats/jd-keywords-union.test.ts src/free/run-free.ts
git add applications/job-strategist/src/ats/jd-keywords-union.ts applications/job-strategist/src/ats/jd-keywords-union.test.ts applications/job-strategist/src/free/run-free.ts
git commit -m "refactor(strategist): jdAtsKeywords single source of truth for ATS universe

Extract the requiredSkills+tools+retrievalKeywords union behind a shared helper
and use it in the free ATS check; the free writer (next task) reuses it so it
optimises for exactly the keywords it is scored on."
```

---

## Task 5: Pillar B envelope + free persona (Pillar A + B) + eval

**Files:**
- Modify: `applications/job-strategist/src/agents/free-resume-writer.ts` (`buildUserMessage`)
- Modify: `applications/job-strategist/src/prompts/free-resume-persona.ts`
- Test: `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts`

**Interfaces:**
- Consumes: `jdAtsKeywords` (Task 4); `JdSignal.hardRequirements[].skill`, `.tools`, `.concepts`.

- [ ] **Step 1: Write failing eval assertions**

In `free-resume-writer.eval.test.ts`, add Pillar A + Pillar B assertions (reuse the eval's existing scaffolding):

```typescript
// Pillar A — truncation + relevance order
it('eval: an 8-bullet role is capped to the first 5 (relevance-ordered)', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `Action ${i + 1} delivered value.`);
    const out = parseFreeResumeResponse(toToolJson({ ...GOOD, resume: { ...GOOD.resume, experience: [{ company: 'Freelance', title: 'Eng', period: 'p', highlights: eight }] } }));
    expect(out.resume.experience[0].highlights).toEqual(eight.slice(0, 5));
    expect(gradeFreeResume(out, EV).pass).toBe(true);
});

// Pillar B — supported JD keyword surfaced, unsupported one stays out
it('eval: surfaces an evidence-backed JD keyword and omits an unsupported one', () => {
    const aliasIdentity = new Map<string, string>();   // identity alias map for the test
    const jdKeywords = ['IAM', 'GraphQL'];             // IAM is in evidence, GraphQL is not
    const resumeWithIam = { /* a FreeResumeOutput whose experience/skills mention IAM, never GraphQL */ };
    const cov = groundedAtsCoverage(JSON.stringify(resumeWithIam), jdKeywords, aliasIdentity);
    expect(cov.covered).toEqual(expect.arrayContaining(['IAM']));
    expect(cov.covered).not.toContain('GraphQL');
});
```

(Use the eval file's real helpers for `toToolJson`/fixture construction. The Pillar B test exercises `groundedAtsCoverage` directly to assert the contract the persona must produce; if the eval runs the live model, instead assert against the model output that `IAM` appears and `GraphQL` does not.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.eval.test.ts -t "capped to the first 5|surfaces an evidence-backed"`
Expected: FAIL — envelope/persona not yet updated (and the cap eval may already pass from Task 2; the Pillar B one fails until the persona/envelope drive it).

- [ ] **Step 3: Implement the envelope (Pillar B)**

In `free-resume-writer.ts` `buildUserMessage`, add JD blocks after `<required_skills>` (conditional, no empty tags):

```typescript
import { jdAtsKeywords } from '../ats/jd-keywords-union.js';
// inside buildUserMessage:
const mustHave = jdSignal.hardRequirements.map((r) => r.skill).filter((s) => s.length > 0);
const atsKeywords = jdAtsKeywords(jdSignal);
// ...in the array, after the <required_skills> line:
mustHave.length ? `<must_have_skills>${mustHave.join(', ')}</must_have_skills>` : '',
jdSignal.tools.length ? `<jd_tools>${jdSignal.tools.join(', ')}</jd_tools>` : '',
jdSignal.concepts.length ? `<jd_concepts>${jdSignal.concepts.join(', ')}</jd_concepts>` : '',
atsKeywords.length ? `<ats_keywords>${atsKeywords.join(', ')}</ats_keywords>` : '',
```

- [ ] **Step 4: Implement the free persona (Pillar A + B)**

In `free-resume-persona.ts`, add two blocks (prompt-only), keeping all existing grounding/positioning rules:

Pillar A — EXPERIENCE SELECTION:
```
Each experience entry has 3-5 impact bullets, hard maximum 5. SELECT and ORDER
each role's bullets by the JD's needs: lead with bullets that evidence the
<must_have_skills> and <required_skills>, then the strongest measurable outcomes.
For a role spanning many projects (e.g. Freelance), choose the 3-5 that best
match the JD and OMIT the rest — do not list everything. Keep each bullet to
1-2 lines.
```

Pillar B — JD OPTIMISATION (ATS):
```
Optimise the experience and skills to THIS JD. For every term in
<must_have_skills>, <jd_tools>, <jd_concepts>, and <ats_keywords> that the
candidate's evidence genuinely supports, surface it — in an experience bullet or
the skills section — using the JD's EXACT wording for ATS exact-match. Do NOT
claim or keyword-stuff any JD term the evidence does not back; omitting an
unsupported skill is correct, not a failure (the grounding rules still apply).
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.eval.test.ts && yarn test src/agents/free-resume-writer.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.ts src/prompts/free-resume-persona.ts src/agents/free-resume-writer.eval.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.ts applications/job-strategist/src/prompts/free-resume-persona.ts applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "feat(free-resume): JD-aware experience — full JD view + ATS optimisation

Widen the writer envelope with must-have skills, JD tools/concepts and the
shared ats-keywords union (what the ATS check scores), and add persona rules to
select bullets by JD relevance and surface evidence-backed JD terms in the JD's
exact wording — grounding gate still blocks unsupported terms."
```

---

## Task 6: paid persona per-role cap line

**Files:**
- Modify: `applications/job-strategist/src/prompts/strategist-persona.ts`

**Interfaces:** none new (prompt-only; paid is already JD-aware via the research brief).

- [ ] **Step 1: Implement (prompt-only)**

In `strategist-persona.ts`, near the word-count budget / trim-order block (`~:337`), add a per-role cap line consistent with the existing rules:

```
Per-role bullet count: 3-5 bullets per experience role, hard maximum 5. Order
each role's bullets by JD relevance (verified matches first). When over the word
budget, the per-role max 5 applies before the generic trim order; never trim a
role below 2 bullets unless it has only one grounded bullet.
```

- [ ] **Step 2: Verify the persona still assembles + suite green**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts && yarn typecheck`
Expected: PASS (prompt string change; existing strategist tests still green).

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/prompts/strategist-persona.ts
git add applications/job-strategist/src/prompts/strategist-persona.ts
git commit -m "feat(strategist): paid persona per-role bullet cap (3-5, hard max 5)

State the per-role ceiling in the strategist persona so it composes with the
existing word budget; truncation enforces it deterministically."
```

---

## Self-Review

**1. Spec coverage:**
- Pillar A cap, deterministic, both paths → Tasks 1 (helper), 2 (free), 3 (paid). ✓
- JD-relevance selection (persona) → Task 5 (free), Task 6 (paid). ✓
- Advisory schema bound (free tool schema only; paid truncation-only — rationale in Global Constraints) → Task 2. ✓
- Pillar B widen JD view (must_have/tools/concepts/ats_keywords) + single-source-of-truth union → Tasks 4 + 5. ✓
- Pillar B active ATS/skill/tech persona rule → Task 5. ✓
- Grader >5 check → Task 2. ✓
- Eval both pillars → Task 5 (+ unit tests in 1-4). ✓
- No new LLM call / no migration → all tasks. ✓

**2. Placeholder scan:** The "match the file's real helper / parser name" notes are verify-against-existing-code instructions; each task's new logic is complete. The paid parser's exported name (`parseTailoredResume` placeholder) MUST be confirmed from `strategist-agent.ts` in Task 3 — it is the one lookup the implementer performs before writing. No TBD/TODO in delivered code.

**3. Type consistency:** `capHighlights<T extends {highlights?: string[]}>(experience, max=5): T[]`, `jdAtsKeywords(jd): string[]`, the four new envelope tags, and the grader `>5` check are consistent across tasks. The ATS union is `requiredSkills ∪ tools ∪ retrievalKeywords` in both `run-free.ts` (Task 4) and the writer envelope (Task 5).
