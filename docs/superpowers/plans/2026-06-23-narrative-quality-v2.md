# Narrative Quality v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cover letters bridge to the company's product/customer reality and keep sentences readable, and make experience/cover-letter bullets lead with plain-language outcomes that surface the grounded metrics already in the data — without weakening the anti-hallucination gate.

**Architecture:** Two deterministic `cover-letter-guard` checks (long-sentence, greeting-format) feed the existing fail-open rewrite. Both personas (free + paid) gain a company-bridge beat, transferable-translation, readability, and plain-language-outcome + grounded/derived-metric rules. The grounding gate (`gradeFreeResume` metric grounding, resume guard) is untouched — derived magnitude is expressed as WORDS so it passes, while coined numbers still get flagged. Eval (free path) covers both pillars, mostly deterministically.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Jest (`@jest/globals`), Bedrock via `runAgent`.

## Global Constraints

- **No new LLM call** (loader-free; the guard rewrite is the pre-existing fail-open Haiku call). **No migration.**
- **Anti-hallucination gate UNCHANGED.** Derived magnitude → WORDS (doubled/halved/eliminated), shown with the source numbers. A literal `%` only when the `%` is in the evidence (e.g. `2.2%`). Never coin/estimate a number. This is why the gate stays strict.
- **Bridge is grounded in the JD signal only** — `<jd_concepts>` (free) + `<company_problem>` (free + paid). Never invent a company fact beyond the JD signal.
- The data is already fed: free `buildUserMessage` has `<company_problem>` + `<jd_concepts>`; paid `buildStrategistMessage` surfaces `research.companyProblem`. **No message-builder change needed** (confirm before relying on it).
- English (UK); `applications/` complexity ceiling 10; ESLint + `yarn typecheck` clean (from `applications/job-strategist`). Tests: `yarn test <path>`.
- Commit bodies as impact bullets; NO "Co-Authored-By: Claude" trailer. No `--no-verify` unless a hook is unrelated+broken (note it).
- **Branch:** `spec/narrative-quality-v2` (off develop). **GIT SAFETY (subagents):** never `git checkout`/`switch`/`pull`/`reset`; confirm `git branch --show-current` is `spec/narrative-quality-v2` before committing; stage only the task's own files (unrelated WIP may exist in the tree).

---

## File Structure

- **Modify** `applications/job-strategist/src/agents/cover-letter-guard.ts` — `long_sentence` + `greeting_format` checks.
- **Modify** `applications/job-strategist/src/agents/cover-letter-guard.test.ts`.
- **Modify** `applications/job-strategist/src/prompts/free-resume-persona.ts` — Pillar 1 + 2 (cover letter contract + experience/impact rules).
- **Modify** `applications/job-strategist/src/prompts/strategist-persona.ts` — Pillar 1 + 2 (paid).
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts` — both-pillar eval.

---

## Task 1: `cover-letter-guard` readability + greeting-format checks

**Files:**
- Modify: `applications/job-strategist/src/agents/cover-letter-guard.ts`
- Test: `applications/job-strategist/src/agents/cover-letter-guard.test.ts`

**Interfaces:**
- Produces: violation codes `long_sentence` and `greeting_format` from `validateCoverLetter`.

- [ ] **Step 1: Write failing tests**

Add to `cover-letter-guard.test.ts` (reuse the file's `SIGNOFF` fixture):

```typescript
it('flags a body sentence longer than 40 words (long_sentence)', () => {
    const long = 'When a silent IAM failure caused every Bedrock Rerank call to fall back to cosine retrieval with no user-visible error I diagnosed it via simulate-principal-policy confirming InvokeModel was allowed while Rerank returned an implicit deny and then corrected the Pod Identity policy in CDK and verified the fix with a live Rerank API test against the running cluster.';
    const letter = { greeting: 'Dear Hiring Manager,', paragraphs: [long], signoff: SIGNOFF } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(true);
});
it('does not flag a letter of short sentences', () => {
    const letter = { greeting: 'Dear Hiring Manager,', paragraphs: ['I resolve IAM incidents at AWS. I traced a compromised key through CloudTrail. I fixed the trust policy fast.'], signoff: SIGNOFF } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(false);
});
it('flags a greeting without a trailing comma (greeting_format)', () => {
    const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I resolve IAM incidents.'], signoff: SIGNOFF } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(true);
});
it('accepts a greeting with a trailing comma', () => {
    const letter = { greeting: 'Dear Hiring Manager,', paragraphs: ['I resolve IAM incidents.'], signoff: SIGNOFF } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/cover-letter-guard.test.ts -t "long_sentence|greeting"`
Expected: FAIL — codes don't exist.

- [ ] **Step 3: Implement**

In `cover-letter-guard.ts`, add near the other consts/helpers:

```typescript
const MAX_SENTENCE_WORDS = 40;

/** True when any body sentence exceeds MAX_SENTENCE_WORDS words. */
function hasLongSentence(paragraphs: readonly string[]): boolean {
    const body = paragraphs.join(' ');
    return body
        .split(/(?<=[.!?])\s+/)
        .some((s) => s.trim().split(/\s+/).filter(Boolean).length > MAX_SENTENCE_WORDS);
}
```

In `validateCoverLetter` (after the existing checks, before `return out`):

```typescript
if (hasLongSentence(letter.paragraphs)) {
    out.push({ code: 'long_sentence', detail: `A sentence exceeds ${MAX_SENTENCE_WORDS} words — split comma-joined clauses into shorter sentences.` });
}
if (letter.greeting.trim().length > 0 && !letter.greeting.trim().endsWith(',')) {
    out.push({ code: 'greeting_format', detail: 'Greeting must end with a comma (e.g. "Dear Hiring Manager,").' });
}
```

Keep `validateCoverLetter` complexity ≤ 10 (it already extracts `checkTitleViolations`/`hasForwardLookingSkillClaim`; the two new lines are simple — extract another helper only if the linter complains).

Confirm the fail-open rewrite path (`guardCoverLetter` → Haiku) forwards violation codes generically (it does: `<issues>${violations.map(v => v.code).join(', ')}</issues>`). If the rewrite's system prompt enumerates fixable codes, add `long_sentence` and `greeting_format` to that list so the rewrite knows to address them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn test src/agents/cover-letter-guard.test.ts`
Expected: PASS (new + existing). The clean short-sentence + comma letter trips neither new code.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/cover-letter-guard.ts src/agents/cover-letter-guard.test.ts
git add applications/job-strategist/src/agents/cover-letter-guard.ts applications/job-strategist/src/agents/cover-letter-guard.test.ts
git commit -m "feat(cover-letter-guard): flag run-on sentences + greeting punctuation

Add deterministic long_sentence (>40 words) and greeting_format (trailing comma)
checks; the existing fail-open rewrite tightens them."
```

---

## Task 2: free persona — company bridge + plain-language outcomes (Pillars 1 & 2)

**Files:**
- Modify: `applications/job-strategist/src/prompts/free-resume-persona.ts`

**Interfaces:** none new (prompt-only). The free writer already receives `<company_problem>`, `<jd_concepts>`, `<must_have_skills>`, `<ats_keywords>`, `<achievements_and_impact>`.

- [ ] **Step 1: Read the persona, then add the rules**

Read `free-resume-persona.ts`. Locate (a) the COVER LETTER contract block (the challenge-led arc added previously) and (b) the experience / impact-bullet block. Add the following (prompt text only; keep all existing rules incl. anti-hallucination and the challenge-led arc):

**To the COVER LETTER contract (Pillar 1):**
```
COMPANY BRIDGE (required, grounded in the JD signal only):
• Name what the company's product actually does, using <jd_concepts> and
  <company_problem> (e.g. CSPM, runtime/threat detection, multi-cloud findings) —
  never invent a company fact beyond the JD signal.
• Translate ONE of the candidate's evidenced strengths into operating that product
  or supporting its customers (e.g. "the cloud-security-graph reasoning I do
  natively in AWS is what your customers operationalise across multi-cloud estates").
• When the JD requires a domain the evidence does not cover (e.g. multi-cloud while
  the evidence is AWS-only), ACTIVELY translate the transferable strength to the
  role's need — do not merely omit, and never name the gap or claim the missing
  skill.
READABILITY:
• Keep sentences to 1-2 lines. Split comma-joined independent clauses into separate
  sentences; prefer a full stop or em-dash over a comma-splice. No sentence over ~40
  words.
• Concision over density: cut the least JD-relevant specifics and reinvest the space
  in company/customer fit, not more proof.
• Keep the AI/automation material only where the JD calls for it (it is JD-relevant
  when <jd_concepts> includes agentic workflows / RAG / AI-driven automation);
  compress it and tie it to the JD's stated AI-support need.
• The greeting MUST end with a comma (e.g. "Dear Hiring Manager,").
```

**To the COVER LETTER contract AND the experience/impact-bullet block (Pillar 2):**
```
PLAIN-LANGUAGE OUTCOME + GROUNDED METRICS:
• Lead each bullet/beat with the plain-language outcome a non-expert screener
  parses, THEN the technical specifics in support. Translate niche jargon into plain
  language (e.g. "half-corpus enrichment" -> "large repos were left with half their
  skills missing"); keep the precise term as a trailing clause, not the lead.
• Aggressively surface the grounded numbers that ARE in the evidence (counts,
  durations, real percentages like 2.2%, e.g. "1,964 chunks", "15->30 min") — do not
  drop them.
• Express derived magnitude as a WORD (doubled, halved, eliminated, cut by half)
  shown alongside the source numbers — NEVER coin a numeric percentage. A literal %
  appears ONLY when that % is in the evidence. A business-impact % (e.g. "cut cost
  40%") appears ONLY if the evidence measured it; otherwise use the plain-language
  outcome and the real counts.
```

- [ ] **Step 2: Verify the persona still assembles + suite green**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts && yarn typecheck`
Expected: PASS (prompt-string change; existing tests still green). If an existing test asserts old cover-letter wording, update it and note it.

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/prompts/free-resume-persona.ts
git add applications/job-strategist/src/prompts/free-resume-persona.ts
git commit -m "feat(free-resume): company-bridge + plain-language outcomes in the free persona

Cover letter now bridges to the company's product/customer reality (grounded in
jd_concepts + company_problem), translates an unevidenced JD domain transferably,
and keeps sentences readable; bullets/beats lead with plain-language outcomes and
surface grounded metrics, deriving magnitude as words (no coined %)."
```

---

## Task 3: paid persona — company bridge + plain-language outcomes (Pillars 1 & 2)

**Files:**
- Modify: `applications/job-strategist/src/prompts/strategist-persona.ts`

**Interfaces:** none new (prompt-only). The paid message surfaces `research.companyProblem`; confirm whether it also surfaces JD concepts/skill vocabulary — if concepts are absent, ground the bridge in `companyProblem` + the JD requirement vocabulary already in the brief (no message change required for this task).

- [ ] **Step 1: Read the persona, then add the rules**

Read `strategist-persona.ts`. Locate the COVER LETTER RULES block and the resume/experience generation rules. Add the SAME substance as Task 2, adapted to the paid persona's voice/format (plain text, 3 paragraphs, exact target role, fixed signoff, no markdown, realised impact only, omit-gaps):
- **Company bridge:** name what the product does from `companyProblem` (+ JD requirement vocabulary in the brief); translate one verified strength into operating it / supporting its customers; transferably translate an unevidenced required domain (never name the gap / claim the skill — the `forward_looking_skill_claim` guard remains the backstop).
- **Readability:** 1-2 line sentences; no sentence over ~40 words; split comma-splices; greeting ends with a comma.
- **Density + AI-tie:** concision over density; keep AI material only where the JD calls for it, compressed.
- **Plain-language outcome + grounded/derived metrics:** lead with the plain-language outcome; surface grounded numbers from the brief/evidence; derived magnitude as WORDS; never coin a `%`; a literal `%` only when grounded.

Keep all existing paid rules (archetype, word budget, per-role bullet cap, anti-hallucination) intact.

- [ ] **Step 2: Verify the persona still assembles + suite green**

Run: `cd applications/job-strategist && yarn test src/agents/strategist-agent.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/prompts/strategist-persona.ts
git add applications/job-strategist/src/prompts/strategist-persona.ts
git commit -m "feat(strategist): company-bridge + plain-language outcomes in the paid persona

Mirror the free persona's company/customer bridge, readability, and plain-language
outcome + grounded/derived-metric rules in the strategist cover-letter + resume
rules; anti-hallucination and word-budget rules unchanged."
```

---

## Task 4: eval — both pillars (free path)

**Files:**
- Modify: `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts`

**Interfaces:**
- Consumes: `validateCoverLetter` (Task 1), free persona behaviour (Task 2), `gradeFreeResume`.

- [ ] **Step 1: Write the eval assertions**

Reuse the eval file's real helpers (`validateCoverLetter`, `GOOD`, `EV`, `gradeFreeResume`). Add deterministic assertions:

```typescript
// Readability — a run-on body sentence is caught; a clean letter is not.
it('eval: a >40-word cover-letter sentence is flagged by the guard', () => {
    const longPara = 'When a silent IAM failure caused every Bedrock Rerank call to fall back to cosine retrieval with no user-visible error I diagnosed it via simulate-principal-policy and confirmed InvokeModel allowed while Rerank returned implicit deny and then corrected the Pod Identity policy in CDK and verified the fix with a live Rerank API call against the cluster.';
    const letter = { greeting: 'Dear Hiring Manager,', paragraphs: [longPara], signoff: GOOD.coverLetter.signoff } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'long_sentence')).toBe(true);
});
// Greeting punctuation
it('eval: a greeting without a comma is flagged', () => {
    const letter = { greeting: 'Dear Hiring Manager', paragraphs: ['I resolve IAM incidents at AWS.'], signoff: GOOD.coverLetter.signoff } as never;
    expect(validateCoverLetter(letter, 'Solutions Support Engineer', '').some((v) => v.code === 'greeting_format')).toBe(true);
});
// Company bridge — a good letter references a JD product concept
it('eval: a good cover letter names a JD product concept (the bridge)', () => {
    const GOOD_BRIDGE = { greeting: 'Dear Hiring Manager,', paragraphs: [
        'I resolve cloud-security incidents at AWS daily — tracing compromised IAM keys through CloudTrail and restoring access fast.',
        'The same investigation method maps to helping your customers operationalise CSPM findings across their multi-cloud estates.',
    ], signoff: GOOD.coverLetter.signoff } as never;
    const text = GOOD_BRIDGE.paragraphs.join(' ');
    expect(/CSPM|multi-cloud|runtime security|threat detection/i.test(text)).toBe(true);   // bridges to the product surface
    expect(validateCoverLetter(GOOD_BRIDGE, 'Solutions Support Engineer', '')).toEqual([]); // clean
});
// Pillar 2 — grounded metric surfaced + no coined %
it('eval: a bullet surfaces a grounded metric and the gate blocks a coined one', () => {
    const grounded = { ...GOOD, resume: { ...GOOD.resume, summary: 'Lifted skills-overlap coverage from 2.2% to full operation and recovered 1,964 chunks.' } } as never;  // 2.2 + 1964 must be in EV
    expect(gradeFreeResume(grounded, EV).pass).toBe(true);
    const coined = { ...GOOD, resume: { ...GOOD.resume, summary: 'Cut per-repo processing cost by 47%.' } } as never;     // 47 not in EV
    expect(gradeFreeResume(coined, EV).failures.some((f) => /47/.test(f))).toBe(true);
});
```

Confirm `2.2` and `1964`/`1,964` are present in the `EV` evidence corpus; if not, add them to the EV fixture's achievement/career evidence (so the grounded-metric case legitimately passes), and pick a coined number genuinely absent from EV.

- [ ] **Step 2: Run to verify (red where expected) then green**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.eval.test.ts`
Expected: the readability/greeting/bridge assertions pass against Task 1's guard; the Pillar-2 grounded case passes and the coined case fails the gate (proving the gate is intact). Adjust EV fixture as noted so the grounded case is legitimately grounded.

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.eval.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "test(free-resume): eval the company bridge, readability, and plain-language metrics

Assert the guard flags run-ons + missing greeting comma, a good letter names a JD
product concept (the bridge), a grounded metric (2.2%) passes the gate, and a coined
percentage still fails it (gate unchanged)."
```

---

## Self-Review

**1. Spec coverage:**
- Pillar 1 company bridge → Tasks 2 (free) + 3 (paid), grounded in already-fed `<jd_concepts>`/`<company_problem>`. ✓
- Multi-cloud transferable-translation → Tasks 2 + 3. ✓
- Readability (persona + deterministic guard) → Task 1 (`long_sentence`) + Tasks 2/3 (persona). ✓
- Greeting comma → Task 1 (`greeting_format`) + Tasks 2/3 (persona). ✓
- Density + AI-tie → Tasks 2 + 3. ✓
- Pillar 2 plain-language outcome + surface grounded metrics + derive-as-words (both surfaces) → Tasks 2 + 3; gate unchanged. ✓
- Eval both pillars, mostly deterministic → Task 4 (+ guard units in Task 1). ✓
- No new LLM call / no migration → all tasks. ✓
- Header-order out of scope (frontend) → not in plan, per spec. ✓

**2. Placeholder scan:** "Read the persona / find the COVER LETTER block / confirm 2.2 & 1964 in EV" are verify-against-existing-code steps; the new guard code + eval assertions are complete. No TBD/TODO in delivered code.

**3. Type consistency:** new violation codes `long_sentence` / `greeting_format` (Task 1) are referenced identically in Task 4; `hasLongSentence(readonly string[])` and the greeting check operate on `CoverLetter.greeting`/`.paragraphs`. Persona changes are prompt-only (no type surface).
