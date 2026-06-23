# Cover-Letter Impact Optimisation + De-Hallucination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cover letter specific + impact-led on both the free and paid paths (challenge-led hook → JD-relevant decision-impacts + achievements → transferable close), grounded in the user's project challenges/decisions/highlights + commits/PRs, and delete the deterministic "actively beginning [tech] onboarding" fabrication rule in favour of grounded transferable framing.

**Architecture:** A shared `loadAchievementEvidence` DB-read loader formats the user's `project_challenges` (problem→solution), `project_decisions` (decision→consequence/impact) and `project_highlights` into one block, fed to BOTH the free writer envelope and the paid strategist message. Both personas are rewritten to a challenge-led, impact-led, transferable arc; the onboarding-fabrication rules are removed from `resume-constraints.ts` + `strategist-persona.ts`; `cover-letter-guard` gains a deterministic `forward_looking_skill_claim` pattern; the free grader extends to the cover letter; eval covers both paths.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Jest (`@jest/globals`), Bedrock via `runAgent`, Postgres (`pg`).

## Global Constraints

- **No new LLM call** beyond the existing pipeline (the loader is a DB read; the guard's rewrite is the pre-existing fail-open Haiku call). **No migration** (all source tables exist + are populated).
- **Anti-hallucination is the safety control:** never name a gap; never claim or state a forward-looking acquisition ("studying/onboarding/learning/pursuing") of an unevidenced skill; surface only evidence-backed transferable strengths. The `cover-letter-guard` pattern is the deterministic net.
- **Arc:** P1 = a specific challenge overcome (hook); P2 = 2-3 JD-relevant **decision-impacts** (`consequences`) + achievements selected for the JD's must-have skills + `companyProblem`; P3 = transferable-strength close. The letter's lead echoes the resume's strongest JD-relevant achievement.
- English (UK); `applications/` complexity ceiling 10; ESLint + `yarn typecheck` clean (run from `applications/job-strategist`). Tests: `yarn test <path>`.
- Commit bodies as impact bullets; NO "Co-Authored-By: Claude" trailer. No `--no-verify` unless a hook is unrelated+broken (note it).
- **Branch:** `spec/cover-letter-impact-optimisation` (stacked on #328). **GIT SAFETY for subagents:** do not `git checkout`/`switch`/`pull`/`reset`; confirm `git branch --show-current` is `spec/cover-letter-impact-optimisation` before committing; stage only the task's own files (unrelated WIP may exist in the tree).

---

## File Structure

- **Create** `applications/job-strategist/src/agents/achievement-evidence.ts` — `loadAchievementEvidence`.
- **Create** `applications/job-strategist/src/agents/achievement-evidence.test.ts`.
- **Modify** `applications/job-strategist/src/free/gather-evidence.ts` — `FreeEvidence.achievementEvidence` + load.
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.ts` — envelope block + grade the cover letter.
- **Modify** `applications/job-strategist/src/agents/strategist-agent.ts` — `StrategistAgentInput.achievementEvidence` + message block.
- **Modify** `applications/job-strategist/src/run-pipeline.ts` — load `loadAchievementEvidence` + pass to strategist input.
- **Modify** `applications/job-strategist/src/agents/cover-letter-guard.ts` — `forward_looking_skill_claim` pattern.
- **Modify** `applications/job-strategist/src/prompts/free-resume-persona.ts` — challenge-led/impact-led/transferable arc.
- **Modify** `applications/job-strategist/src/prompts/strategist-persona.ts` — same arc + delete GCP onboarding gate.
- **Modify** `applications/job-strategist/src/prompts/resume-constraints.ts` — delete onboarding rule lines.
- **Modify** test/eval: `cover-letter-guard.test.ts`, `free-resume-writer.test.ts`, `free-resume-writer.eval.test.ts`.

---

## Task 1: `loadAchievementEvidence` shared loader

**Files:**
- Create: `applications/job-strategist/src/agents/achievement-evidence.ts`
- Test: `applications/job-strategist/src/agents/achievement-evidence.test.ts`

**Interfaces:**
- Produces: `loadAchievementEvidence(pool: Pool, userId: string): Promise<string>` — formatted block or `''`.

- [ ] **Step 1: Write the failing test (fake pool dispatching on SQL)**

```typescript
/** @format */
import { loadAchievementEvidence } from './achievement-evidence.js';

function makePool(rows: { challenges?: unknown[]; decisions?: unknown[]; highlights?: unknown[] }) {
    return {
        query: async (sql: string) => {
            if (/FROM project_challenges/.test(sql)) return { rows: rows.challenges ?? [] };
            if (/FROM project_decisions/.test(sql))  return { rows: rows.decisions ?? [] };
            if (/FROM project_highlights/.test(sql)) return { rows: rows.highlights ?? [] };
            return { rows: [] };
        },
    } as never;
}

describe('loadAchievementEvidence', () => {
    it('formats challenges, decision-impacts and achievements into labelled groups', async () => {
        const out = await loadAchievementEvidence(makePool({
            challenges: [{ problem: 'bedrock:Rerank failed silently', solution: 'traced via simulate-principal-policy, shipped CDK fix' }],
            decisions:  [{ decision: 'Migrate edge to EKS ALB, retire CloudFront', consequences: 'cut an edge layer and its failure surface' }],
            highlights: [{ title: 'Controlled-vocabulary enrichment', description: 'skills overlap lifted from 2.2% to full operation' }],
        }), 'u1');
        expect(out).toContain('Challenges overcome');
        expect(out).toContain('bedrock:Rerank failed silently -> traced via simulate-principal-policy');
        expect(out).toContain('Decision impact');
        expect(out).toContain('Migrate edge to EKS ALB, retire CloudFront -> cut an edge layer');
        expect(out).toContain('Achievements');
        expect(out).toContain('Controlled-vocabulary enrichment — skills overlap lifted');
    });
    it('returns empty string when nothing is populated (fail-open)', async () => {
        expect(await loadAchievementEvidence(makePool({}), 'u1')).toBe('');
    });
    it('returns empty string when a query throws', async () => {
        const pool = { query: async () => { throw new Error('db down'); } } as never;
        expect(await loadAchievementEvidence(pool, 'u1')).toBe('');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/achievement-evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * Achievement & impact evidence — the specific, grounded material that makes a
 * cover letter concrete instead of generic. Pure DB read (no LLM) of the user's
 * project_challenges (problem -> solution), project_decisions
 * (decision -> consequence == impact) and project_highlights (achievements).
 * Fail-open to '' so a user with no case study still generates a letter from
 * career/commit-PR/KB evidence.
 */
import type { Pool } from 'pg';

const CHALLENGE_CAP = 4;
const DECISION_CAP = 4;
const HIGHLIGHT_CAP = 4;

interface ChallengeRow { problem: string; solution: string }
interface DecisionRow { decision: string; consequences: string }
interface HighlightRow { title: string; description: string }

export async function loadAchievementEvidence(pool: Pool, userId: string): Promise<string> {
    try {
        const [challenges, decisions, highlights] = await Promise.all([
            pool.query<ChallengeRow>(
                `SELECT problem, solution FROM project_challenges WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
                [userId, CHALLENGE_CAP],
            ),
            pool.query<DecisionRow>(
                `SELECT decision, consequences FROM project_decisions WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
                [userId, DECISION_CAP],
            ),
            pool.query<HighlightRow>(
                `SELECT title, description FROM project_highlights WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
                [userId, HIGHLIGHT_CAP],
            ),
        ]);

        const groups: string[] = [];
        if (challenges.rows.length > 0) {
            groups.push(
                'Challenges overcome (problem -> how it was solved):\n' +
                challenges.rows.map((r) => `- ${r.problem} -> ${r.solution}`).join('\n'),
            );
        }
        if (decisions.rows.length > 0) {
            groups.push(
                'Decision impact (decision -> consequence; pick those relevant to the role):\n' +
                decisions.rows.map((r) => `- ${r.decision} -> ${r.consequences}`).join('\n'),
            );
        }
        if (highlights.rows.length > 0) {
            groups.push(
                'Achievements:\n' +
                highlights.rows.map((r) => `- ${r.title} — ${r.description}`).join('\n'),
            );
        }
        return groups.join('\n\n');
    } catch {
        return '';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/agents/achievement-evidence.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/achievement-evidence.ts src/agents/achievement-evidence.test.ts
git add applications/job-strategist/src/agents/achievement-evidence.ts applications/job-strategist/src/agents/achievement-evidence.test.ts
git commit -m "feat(strategist): achievement & impact evidence loader for cover letters

Pure DB read of project_challenges (problem->solution), project_decisions
(decision->consequence/impact) and project_highlights; the specific grounded
material a cover letter needs. Fail-open to empty."
```

---

## Task 2: wire achievement evidence into the FREE writer

**Files:**
- Modify: `applications/job-strategist/src/free/gather-evidence.ts`
- Modify: `applications/job-strategist/src/agents/free-resume-writer.ts` (`buildUserMessage` only)
- Test: `applications/job-strategist/src/free/gather-evidence.test.ts`

**Interfaces:**
- Consumes: `loadAchievementEvidence` (Task 1).
- Produces: `FreeEvidence.achievementEvidence: string`; `<achievements_and_impact>` envelope block.

- [ ] **Step 1: Update the gather test**

In `gather-evidence.test.ts`, assert the returned `FreeEvidence` has `achievementEvidence` (a string; `''` with the empty fake pool):

```typescript
expect(typeof ev.achievementEvidence).toBe('string');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts`
Expected: FAIL — property absent / type error.

- [ ] **Step 3: Implement**

In `gather-evidence.ts`:
- `import { loadAchievementEvidence } from '../agents/achievement-evidence.js';`
- Add `readonly achievementEvidence: string;` to the `FreeEvidence` interface.
- Add `loadAchievementEvidence(pool, env.userId)` to the existing `Promise.all` (it is fail-open internally) and return it in the result object.

In `free-resume-writer.ts` `buildUserMessage`, add a conditional block inside `<evidence>` (after `<commit_pr_evidence>`):

```typescript
evidence.achievementEvidence ? `<achievements_and_impact>\n${evidence.achievementEvidence}\n</achievements_and_impact>` : '',
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts src/agents/free-resume-writer.test.ts && yarn typecheck`
Expected: PASS; 0 type errors (the `FreeEvidence` literal fixtures in the writer tests may need `achievementEvidence: ''` added — update them).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/gather-evidence.ts src/agents/free-resume-writer.ts src/free/gather-evidence.test.ts
git add applications/job-strategist/src/free/gather-evidence.ts applications/job-strategist/src/agents/free-resume-writer.ts src/free/gather-evidence.test.ts applications/job-strategist/src/agents/free-resume-writer.test.ts applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "feat(free-resume): feed challenge/decision-impact/achievement evidence to the writer

Add FreeEvidence.achievementEvidence (fail-open DB read) and an
<achievements_and_impact> envelope block so the cover letter can lead with real
challenges overcome and JD-relevant decision impacts."
```

(Stage only the eval/writer test files you actually touched for the fixture fix.)

---

## Task 3: wire achievement evidence into the PAID strategist

**Files:**
- Modify: `applications/job-strategist/src/agents/strategist-agent.ts`
- Modify: `applications/job-strategist/src/run-pipeline.ts`

**Interfaces:**
- Consumes: `loadAchievementEvidence` (Task 1).
- Produces: `StrategistAgentInput.achievementEvidence?: string` injected into the strategist message.

- [ ] **Step 1: Write a failing test**

In `strategist-agent.test.ts` (or the message-builder test if separate), add a test that `buildStrategistMessage` / the agent's `buildUserMessage` includes the achievement block when `achievementEvidence` is provided. Find how the file tests `buildStrategistMessage` (it takes `research, ctx, projectEvidence, educationFacts, experienceFacts, roleEvidence, yearsGapFraming, codeStackContext`). Assert the rendered message contains the achievement text:

```typescript
it('injects achievement & impact evidence into the strategist message', () => {
    const msg = buildStrategistMessage(MIN_RESEARCH, CTX, '', '', '', '', '', '', 'Decision impact (decision -> consequence):\n- X -> Y');
    expect(msg).toContain('Decision impact');
    expect(msg).toContain('X -> Y');
});
```

(Match the real `buildStrategistMessage` arity — add `achievementEvidence` as a new trailing parameter; confirm the exact existing signature before editing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts -t "achievement"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `strategist-agent.ts`:
- Add `readonly achievementEvidence?: string;` to `StrategistAgentInput` (near `projectEvidence`, line ~58).
- Add a trailing `achievementEvidence = ''` parameter to `buildStrategistMessage` (line ~118-123) and, mirroring the `projectEvidence` block (~line 285), push a section when non-empty:
```typescript
if (achievementEvidence) {
    sections.push(
        '',
        '### Achievement & Impact Evidence (use for the cover letter: lead with a challenge overcome; surface decision impacts relevant to the JD)',
        achievementEvidence,
    );
}
```
- Thread it through the agent's `buildUserMessage` call (line ~690): add `input.achievementEvidence` as the matching trailing argument.

In `run-pipeline.ts`:
- `import { loadAchievementEvidence } from './agents/achievement-evidence.js';`
- Add `loadAchievementEvidence(pool, ctx.userId)` to the `Promise.all` at line ~487 (destructure a new `achievementEvidenceBlock`).
- Pass `achievementEvidence: achievementEvidenceBlock` into the strategist input object (where `projectEvidence: projectEvidenceBlock` is passed, ~line 816).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/strategist-agent.ts src/run-pipeline.ts src/agents/strategist-agent.test.ts
git add applications/job-strategist/src/agents/strategist-agent.ts applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/agents/strategist-agent.test.ts
git commit -m "feat(strategist): feed achievement & impact evidence into the paid cover letter

Thread achievementEvidence through StrategistAgentInput + buildStrategistMessage
and load it in run-pipeline, so the paid cover letter leads with real challenges
overcome and JD-relevant decision impacts."
```

---

## Task 4: `cover-letter-guard` forward-looking-skill-claim pattern

**Files:**
- Modify: `applications/job-strategist/src/agents/cover-letter-guard.ts`
- Test: `applications/job-strategist/src/agents/cover-letter-guard.test.ts`

**Interfaces:**
- Produces: a new violation `code: 'forward_looking_skill_claim'` from `validateCoverLetter`.

- [ ] **Step 1: Write failing tests**

```typescript
it('flags a forward-looking skill-acquisition claim (the Azure/GCP fabrication)', () => {
    const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['My AWS depth is strong and I am actively beginning Azure and GCP onboarding, pursued with urgency.'], signoff: SIGN } as never;
    const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
    expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(true);
});
it('does NOT flag legitimate "onboarding" usage (people, not a skill the candidate lacks)', () => {
    const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I authored the runbook adopted for new engineer onboarding across the team.'], signoff: SIGN } as never;
    const v = validateCoverLetter(letter, 'Solutions Support Engineer', '');
    expect(v.some((x) => x.code === 'forward_looking_skill_claim')).toBe(false);
});
```

(Reuse the file's existing signoff fixture / `SIGN`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/cover-letter-guard.test.ts -t "forward-looking"`
Expected: FAIL — no such code.

- [ ] **Step 3: Implement**

In `cover-letter-guard.ts`, add the pattern near the other consts (line ~12-22) and a check in `validateCoverLetter` (after the `GAP_PATTERNS` loop, ~line 44):

```typescript
// Forward-looking skill-acquisition claim — the candidate states they are
// learning/onboarding a skill they lack (e.g. "actively beginning Azure
// onboarding"). Scoped to a present-progressive intent verb + an acquisition
// verb so legitimate "new engineer onboarding" (people, not a skill) does NOT fire.
const FORWARD_LOOKING_SKILL = /\b(actively|currently|presently|now)\b[^.]{0,40}\b(begin|beginning|start|starting|pursu(?:e|ing)|onboard(?:ing)?|learn(?:ing)?|study(?:ing)?|ramping up|upskilling|self-?teach(?:ing)?)\b/i;
// inside validateCoverLetter, after the GAP_PATTERNS loop:
if (FORWARD_LOOKING_SKILL.test(text)) {
    out.push({ code: 'forward_looking_skill_claim', detail: 'Claims to be actively learning/onboarding a skill — omit unevidenced forward-looking acquisition; use grounded transferable framing instead.' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn test src/agents/cover-letter-guard.test.ts`
Expected: PASS (new + existing). The legitimate-"onboarding" sentence must NOT fire (the regex requires a nearby "actively/currently/now" intent word, which that sentence lacks).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/cover-letter-guard.ts src/agents/cover-letter-guard.test.ts
git add applications/job-strategist/src/agents/cover-letter-guard.ts applications/job-strategist/src/agents/cover-letter-guard.test.ts
git commit -m "feat(strategist): cover-letter-guard flags forward-looking skill-acquisition claims

Add a forward_looking_skill_claim pattern so 'actively beginning Azure/GCP
onboarding'-style fabrications are caught deterministically (and stripped by the
existing rewrite); scoped to avoid false-firing on legitimate people onboarding."
```

---

## Task 5: delete the onboarding rule + challenge-led/transferable personas

**Files:**
- Modify: `applications/job-strategist/src/prompts/resume-constraints.ts`
- Modify: `applications/job-strategist/src/prompts/strategist-persona.ts`
- Modify: `applications/job-strategist/src/prompts/free-resume-persona.ts`

**Interfaces:** none new (prompt-only).

- [ ] **Step 1: Delete the fabrication rules**

In `resume-constraints.ts`:
- Delete the evidence-gate row (line ~358) that maps `"Actively pursuing" with no confirmed activity → "I am actively beginning [technology] onboarding"`.
- Delete the GKE onboarding-signal line (~218): `GKE onboarding signal: ... add "GKE (actively onboarding)" ...`.
- Where a gap is currently described with a forward-looking "IN_PROGRESS / actively pursuing" framing (lines ~343, ~351), change to plain omission ("not in the portfolio; do not mention").

In `strategist-persona.ts`:
- Delete the GCP EVIDENCE GATE block (~lines 379-386) — specifically the `Add "GKE (actively onboarding)"` and `Cover letter: use "actively beginning GCP onboarding"` lines. Replace with the transferable-framing rule (Step 2).
- Keep the existing `OMIT gaps entirely. Omission is not dishonesty; never fabricate.` line (~221) — it is now consistent.

- [ ] **Step 2: Add the transferable-framing rule (both personas)**

Add to BOTH `strategist-persona.ts` (cover letter rules) and `free-resume-persona.ts` (cover letter contract):

```
TRANSFERABLE FRAMING (never name a gap, never claim a missing skill):
When the JD requires a skill the evidence does not support, do NOT mention it, do
NOT say you are studying/onboarding/learning it, and do NOT name the gap. Instead,
where it is genuinely relevant to the role, surface the closest skill the evidence
DOES support, framed as transferable to the role's need (e.g. a cloud-agnostic
investigation methodology proven on AWS). Only when relevant; otherwise omit.
```

- [ ] **Step 3: Rewrite the cover-letter arc (both personas)**

Replace the COVER LETTER CONTRACT (free) / COVER LETTER RULES (paid) body with the challenge-led, impact-led arc (keep existing format rules — plain text, 3 paragraphs, name the exact target role, fixed signoff, no markdown, only realised impact):

```
COVER LETTER — challenge-led, impact-led, specific (3 paragraphs):
• P1 (hook): open with ONE specific challenge the candidate overcame, drawn from
  <achievements_and_impact> (the Challenges group) or commit/PR/project evidence —
  name the real problem and how it was resolved. NO "I am writing to apply" / "I am
  passionate" filler.
• P2 (why-fit, impact-led): 2-3 beats, each a DECISION + its IMPACT (the
  consequence) or a challenge + its outcome or a concrete achievement — SELECTED
  for relevance to the JD's must-have skills and companyProblem, not the most
  technically impressive. Use the JD's exact skill/tool wording where the evidence
  supports it.
• P3 (close): a transferable strength tied to the role; forward-looking in tone but
  grounded; NEVER name a gap or a skill the candidate lacks.
• The letter's lead must echo the resume's strongest JD-relevant achievement (same
  headline story/tech as the resume).
• All existing anti-hallucination rules still apply: no invented metrics, employers,
  skills; omit what the evidence does not support.
```

- [ ] **Step 4: Verify personas still assemble + suites green**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts src/agents/free-resume-writer.test.ts && yarn typecheck`
Expected: PASS (prompt-string changes; existing tests still green). If any existing test asserts the old onboarding wording, update it to the new omission/transferable behaviour and note it.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/prompts/resume-constraints.ts src/prompts/strategist-persona.ts src/prompts/free-resume-persona.ts
git add applications/job-strategist/src/prompts/resume-constraints.ts applications/job-strategist/src/prompts/strategist-persona.ts applications/job-strategist/src/prompts/free-resume-persona.ts
git commit -m "feat(strategist): challenge-led cover-letter arc + drop onboarding fabrication

Remove the deterministic 'actively beginning [tech] onboarding' rule (resume-
constraints + GCP gate) and replace with grounded transferable framing; rewrite
both personas to a challenge-led, impact-led arc (challenge hook -> JD-relevant
decision impacts -> transferable close) that echoes the resume headline."
```

---

## Task 6: grade the free cover letter + two-path eval

**Files:**
- Modify: `applications/job-strategist/src/agents/free-resume-writer.ts` (`gradeFreeResume`)
- Test: `applications/job-strategist/src/agents/free-resume-writer.test.ts`, `free-resume-writer.eval.test.ts`

**Interfaces:**
- Consumes: `validateCoverLetter` behaviour (Task 4), achievement envelope (Task 2), personas (Task 5).

- [ ] **Step 1: Write failing tests**

In `free-resume-writer.test.ts` (grader unit) — the grader must now scan the cover letter's paragraphs for fabricated metrics:

```typescript
it('gradeFreeResume flags a fabricated metric in the cover letter', () => {
    const bad = { ...GOOD, coverLetter: { ...GOOD.coverLetter, paragraphs: ['I cut latency by 73% across the platform.'] } } as never;  // 73 not in evidence
    expect(gradeFreeResume(bad, EV).failures.some((f) => /cover letter/i.test(f) && /73/.test(f))).toBe(true);
});
```

In `free-resume-writer.eval.test.ts` add the cover-letter contract assertions:

```typescript
// no forward-looking fabrication
it('eval: a forward-looking skill-acquisition cover letter is flagged by the guard', () => {
    const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I am actively beginning Azure onboarding.'], signoff: GOOD.coverLetter.signoff } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'forward_looking_skill_claim')).toBe(true);
});
// challenge-led hook + decision-impact present (deterministic check over a good fixture)
it('eval: a good cover letter references a challenge/achievement and a decision impact', () => {
    const text = GOOD_CL.paragraphs.join(' ');                 // GOOD_CL = a hand-built challenge-led letter
    expect(/bedrock:Rerank|simulate-principal-policy|enrichment/i.test(text)).toBe(true);     // challenge/achievement
    expect(/retir(e|ed)|cut .* layer|reduced|consolidat/i.test(text)).toBe(true);             // a decision-impact phrase
    expect(gradeFreeResume({ ...GOOD, coverLetter: GOOD_CL } as never, EV).pass).toBe(true);  // grounded
});
```

(Reuse the eval file's real `GOOD`/`EV`/`validateCoverLetter` imports; build `GOOD_CL` from the same evidence the fixtures use so it is grounded.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts -t "cover letter" && yarn test src/agents/free-resume-writer.eval.test.ts -t "cover letter"`
Expected: FAIL — grader does not yet scan the cover letter.

- [ ] **Step 3: Implement the grader extension**

In `free-resume-writer.ts` `gradeFreeResume`, after the existing metric-grounding loop, scan the cover-letter paragraphs for fabricated metrics (reuse `extractNumberTokens` + `isMetricGrounded`):

```typescript
// Cover-letter metric grounding (the letter is otherwise ungraded)
for (const para of out.coverLetter.paragraphs) {
    for (const token of extractNumberTokens(para)) {
        if (!isMetricGrounded(token, corpusTokens)) {
            failures.push(`Fabricated metric "${token}" in cover letter: "${para}".`);
        }
    }
}
```

(Scope: metric grounding on the letter — the deterministic fabrication vector. Skill-acquisition fabrication is covered by `cover-letter-guard` (Task 4); employer NER on free prose is out of scope and noisy.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts src/agents/free-resume-writer.eval.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.ts src/agents/free-resume-writer.test.ts src/agents/free-resume-writer.eval.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.ts applications/job-strategist/src/agents/free-resume-writer.test.ts applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "feat(free-resume): grade the cover letter + eval the impact-led contract

Extend gradeFreeResume to metric-ground the cover letter (previously ungraded),
and add eval coverage: no forward-looking skill fabrication, a challenge-led hook,
a JD-relevant decision-impact beat, and grounded claims."
```

---

## Self-Review

**1. Spec coverage:**
- New achievement/impact evidence block (challenges/decisions/highlights) → Tasks 1, 2 (free), 3 (paid). ✓
- Challenge-led, impact-led, transferable arc (both personas) → Task 5. ✓
- Decision-impact (consequence) surfaced + JD-relevant selection → Task 1 (loads `consequences`), Task 5 (persona P2), Task 6 (eval). ✓
- Delete onboarding fabrication rule + transferable framing → Task 5. ✓
- `cover-letter-guard` forward-looking pattern → Task 4. ✓
- Free grader grades the cover letter → Task 6. ✓
- Resume↔letter sync (lead echoes resume) → Task 5 (persona rule; prompt-only, per spec). ✓
- Eval both pillars → Task 6 (+ unit tests in 1, 4). ✓
- No new LLM call / no migration → all tasks. ✓

**2. Placeholder scan:** The "confirm the real `buildStrategistMessage` arity / find the file's `SIGN`/`GOOD_CL` fixture" notes are verify-against-existing-code instructions; each task's new logic is complete. The exact line numbers (resume-constraints ~358/218/343/351, strategist-persona ~379-386, run-pipeline ~487/816) are starting anchors the implementer confirms before editing. No TBD/TODO in delivered code.

**3. Type consistency:** `loadAchievementEvidence(pool, userId): Promise<string>`, `FreeEvidence.achievementEvidence: string`, `StrategistAgentInput.achievementEvidence?: string`, the `<achievements_and_impact>` envelope tag, the `forward_looking_skill_claim` violation code, and the grader's cover-letter loop are consistent across tasks.
