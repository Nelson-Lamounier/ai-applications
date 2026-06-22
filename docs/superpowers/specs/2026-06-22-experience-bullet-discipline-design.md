# Experience Bullet Discipline — per-role cap + JD-relevance selection

- **Date:** 2026-06-22
- **Status:** Design approved, awaiting spec review
- **Repo:** ai-applications / job-strategist
- **Stacked on:** `spec/free-tier-cost-and-narrative` (PR #327) — edits the free persona/grader that PR introduced.

## Problem

The generated resume's Experience section has no per-role bullet ceiling and no
JD-relevance selection. Observed on the live free run `7a586686` (Wiz Solutions
Support Engineer): the **Freelance** role expanded to **8 bullets** (17 total),
several of which (16-stack CDK platform, Bedrock/RAG AI platform, LGTM
observability) showcase platform-build breadth rather than the JD's must-have
skills (cloud security, IAM, networking, troubleshooting). The paid run was
tighter (6/6/2 = 14) but only via a reactive word budget.

Root cause (verified in code):
- **Schema:** `highlights: array<string>` with no `maxItems` — free
  (`free-resume-writer.ts:107`) and paid (`strategist-agent.ts:573`).
- **Free persona:** caps per-bullet *length* ("1-2 sentences") but never
  bullets-per-role; "weave JD skills where evidence backs them" is keyword
  weaving, not select-by-JD-relevance.
- **Free grader `gradeFreeResume`:** checks grounding/positioning/action-verb —
  never count, length, or JD-relevance.
- **Free has less discipline than paid:** paid has a 370-word experience budget +
  reactive trim ("cut least JD-relevant bullet from the oldest role"); free has
  no budget, no trim, no per-role balancing.
- **Freelance inflates** because it has the richest evidence surface (RAG +
  project + the new commit/PR evidence all map to that self-employed work) and
  nothing tells the writer to stop.

## Goals

- Enforce **2-5 bullets per experience role** (hard cap 5, floor 2) on **both**
  the free and paid resume writers.
- Make bullet selection **JD-relevance-led**: lead each role with bullets that
  serve the JD's must-have skills; for multi-project roles (e.g. Freelance) pick
  the strongest JD-matched and omit the rest.
- Make the cap **deterministic** (not reliant on the LLM honouring `maxItems`).
- Cover with eval per CLAUDE.md (no prompt change without its eval).

## Non-goals

- Changing the number of experience *entries* (stays as-is, ~3).
- Per-bullet length rewriting beyond reaffirming the existing "1-2 lines" rule.
- The paid word-budget mechanism (kept; the per-role cap complements it).
- Any schema/DB migration.

## Design

Three layers, applied to both paths. The cap value: **min 2, max 5 per role.**

### 1. Deterministic post-parse truncation (the hard safety net)
After the writer's output is parsed, truncate each experience role's
`highlights` to the first **5** (the persona orders by JD relevance, so the first
5 are the most relevant). This is the real guarantee — independent of whether
Bedrock honours `maxItems`.

- **Free:** in `free-resume-writer.ts`, in the parse step (`parseFreeResumeResponse`
  or immediately after), map each `experience[].highlights` to `.slice(0, 5)`.
  Add a small pure helper `capHighlights(experience, max = 5)` so it is unit-testable.
- **Paid:** the strategist parses its tailored-resume JSON in `strategist-agent.ts`;
  apply the same `capHighlights` to `tailoredResumeData.experience` after parse.
  Extract `capHighlights` to a shared module both import (e.g.
  `applications/job-strategist/src/agents/experience-cap.ts`) — DRY.

### 2. Schema advisory bound
Add `minItems: 2, maxItems: 5` to the `highlights` array:
- Free raw tool schema (`free-resume-writer.ts:107`): `{ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 }`.
- Paid Zod schema (`strategist-agent.ts:573`): `z.array(z.string()).min(2).max(5)`.
This nudges the model and (for paid Zod) makes >5 a parse error caught by the
existing schema-repair/retry; the deterministic truncation remains the backstop.

### 3. Persona JD-relevance selection rule (proactive)
Prompt-only, both personas:
- **Free** (`free-resume-persona.ts`): add an EXPERIENCE SELECTION block —
  "3-5 bullets per role (hard max 5). SELECT and ORDER bullets by the JD's
  must-have skills in `<required_skills>`: lead with bullets that evidence those
  skills, then strongest measurable outcomes. For roles spanning many projects
  (e.g. Freelance), choose the 3-5 that best match the JD and OMIT the rest — do
  not list everything. Keep each bullet to 1-2 lines." Reaffirm the existing
  grounding rules (selection never licenses fabrication).
- **Paid** (`strategist-persona.ts`): add a per-role cap line to the generation
  rules near the word budget (`:337`) — "3-5 bullets per experience role
  (hard max 5); order each role's bullets by JD relevance (verified matches
  first); when over the word budget, the per-role max 5 applies before the
  generic trim order."

### 4. Grader + eval
- **Free grader `gradeFreeResume`:** add a check that no role exceeds 5
  highlights (defensive — truncation makes this always pass, but it documents the
  contract and catches a regression if truncation is removed). Optionally flag a
  role with <2.
- **Eval:** extend `free-resume-writer.eval.test.ts` — a fixture whose writer
  output has a role with 8 highlights is truncated to 5 by `capHighlights`; assert
  the kept 5 are the first 5 (relevance order preserved); assert the grader passes
  post-cap and would flag pre-cap. Add a paid-side unit test for `capHighlights`.

## Architecture / data flow (unchanged except the cap)

```
writer output (LLM) → parse → capHighlights(experience, 5)  ← NEW deterministic cap
                                   ↓
                          grade (now asserts ≤5/role)
                                   ↓
                          persist resume
```

## Error handling
- `capHighlights` is pure and total: a role with ≤5 highlights is unchanged; a
  missing/empty `highlights` stays empty; never throws.
- Schema `maxItems`/`.max(5)`: for paid Zod a violation routes through existing
  schema-repair retry; for the free raw schema it is advisory (truncation is the
  guarantee).

## Testing
- **Unit:** `capHighlights` (8→5 keeping first 5; 3→3 unchanged; 0→0; missing
  field safe). Free grader >5 check. 
- **Eval:** free writer eval truncation + relevance-order assertion + grader pass.
- **Manual:** a fresh free run on a security-support JD shows Freelance ≤5 bullets,
  led by the JD's security/IAM/networking skills, AI/CDK-platform bullets dropped.

## Acceptance criteria
- No experience role in free or paid output exceeds 5 highlights (deterministic).
- Free/paid personas instruct JD-relevance-led selection + omission for rich roles.
- `capHighlights` is shared (DRY) and unit-tested; eval extended; grader documents
  the cap.
- No new LLM call; no migration; ESLint + typecheck clean.

## Risks & mitigations
- **Truncation drops a relevant bullet if the LLM ordered poorly:** mitigated by
  the persona ordering rule (lead with JD-relevant) — truncation keeps the first
  5, which the persona makes the most relevant. Eval asserts order preservation.
- **Paid word budget vs per-role cap interaction:** the cap is an upper bound;
  the word budget can trim further. Stated in the persona so they compose.
- **Min-2 floor on a genuinely thin role:** floor is advisory in the persona, not
  enforced by truncation (we never pad); the grader only warns, never blocks.
