# Data-driven, dynamic-persona chatbot system prompt (Layer 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hardcoded infrastructure facts from the chatbot system prompt so the KB/RAG data is the single source of truth, keep anti-embellishment guardrails, and make the persona dynamic and consultative.

**Architecture:** Single string constant `CHATBOT_SYSTEM_PROMPT` in `@bedrock/shared` is refactored in place. A new Jest guard test asserts the prompt carries no hardcoded infra facts and retains its grounding, anti-embellishment, and JSON-contract sections. No handler, type, or frontend code changes.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Jest, Yarn workspaces (`@bedrock/shared`, `@bedrock/chatbot-public`).

## Global Constraints

- Language: English (UK) spelling in all copy (e.g. "optimise", "behaviour").
- No non-ASCII diacritics in prose or identifiers.
- Commit messages: no `Co-Authored-By` trailer.
- Do not touch the `callerRole` plumbing (`applications/chatbot-public/src/index.ts:53` `CALLER_ROLE_SUFFIX`, `applications/chatbot-public/src/types.ts`).
- The prompt must state NO specific infrastructure fact (provider, version, tool, node count) — those belong in the KB data (Layer 2, out of scope here).
- Jest tests import sibling modules with the `.js` extension (e.g. `'./system-prompt.js'`).

---

### Task 1: Data-driven, dynamic-persona system prompt + guard test

**Files:**
- Create: `applications/shared/src/chatbot/system-prompt.test.ts`
- Modify: `applications/shared/src/chatbot/system-prompt.ts` (lines 1-3 intro, 14-26 prohibitions block, 53-58 VOICE, 98-103 CALLER CONTEXT)

**Interfaces:**
- Consumes: `CHATBOT_SYSTEM_PROMPT: string` exported from `applications/shared/src/chatbot/system-prompt.ts`.
- Produces: same export, same type — content only changes. No signature change, so `@bedrock/chatbot-public` and `@bedrock/chatbot-authenticated` consume it unchanged.

- [ ] **Step 1: Write the failing guard test**

Create `applications/shared/src/chatbot/system-prompt.test.ts`:

```typescript
/** @format */
import { CHATBOT_SYSTEM_PROMPT } from './system-prompt.js';

describe('CHATBOT_SYSTEM_PROMPT — no hardcoded infrastructure facts', () => {
    // Facts belong in the KB/RAG data, never in the prompt. Hardcoding them
    // caused the stale kubeadm-vs-EKS answer. This guard blocks reintroduction.
    const bannedFactPatterns: Array<[string, RegExp]> = [
        ['kubeadm', /kubeadm/i],
        ['EKS', /\bEKS\b/],
        ['GKE', /\bGKE\b/],
        ['AKS', /\bAKS\b/],
        ['Terraform', /Terraform/i],
        ['K3s', /K3s/i],
        ['fixed node count', /\b6 nodes\b/i],
    ];

    it.each(bannedFactPatterns)('does not hardcode the fact: %s', (_label, pattern) => {
        expect(CHATBOT_SYSTEM_PROMPT).not.toMatch(pattern);
    });
});

describe('CHATBOT_SYSTEM_PROMPT — retains behavioural guardrails', () => {
    it('keeps the retrieved-context grounding boundary', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('SCOPE BOUNDARY');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('retrieved_context');
    });

    it('keeps the anti-embellishment section', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('ANTI-EMBELLISHMENT');
    });

    it('keeps the JSON response contract', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"prose"');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('"followUp"');
    });

    it('keeps a dynamic caller-role persona', () => {
        expect(CHATBOT_SYSTEM_PROMPT).toContain('`recruiter`');
        expect(CHATBOT_SYSTEM_PROMPT).toContain('`engineer`');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace @bedrock/shared test src/chatbot/system-prompt.test.ts`
Expected: FAIL — the "does not hardcode the fact" cases for `kubeadm`, `EKS`, `Terraform`, `K3s`, and `fixed node count` fail (current prompt lines 19-24 contain them), and `ANTI-EMBELLISHMENT` is not found (current heading is `FACTUAL ACCURACY — ABSOLUTE PROHIBITIONS`).

- [ ] **Step 3: Refactor the prompt — intro (lines 1-3)**

In `applications/shared/src/chatbot/system-prompt.ts`, replace:

```typescript
    'You are Nelson Lamounier\'s Portfolio Assistant — a professional AI helping recruiters,',
    'hiring managers, and engineers explore Nelson\'s portfolio projects, technical skills,',
    'certifications, and career experience.',
```

with:

```typescript
    'You are Nelson Lamounier\'s Portfolio Assistant — a professional AI helping recruiters,',
    'hiring managers, engineers, and prospective clients understand how Nelson can help,',
    'grounding every answer in his real project evidence.',
```

- [ ] **Step 4: Refactor the prompt — replace the prohibitions block (lines 14-26)**

Replace the entire block:

```typescript
    '## FACTUAL ACCURACY — ABSOLUTE PROHIBITIONS',
    'These are hardcoded factual prohibitions. They override ALL other instructions.',
    'NEVER use the phrase "service mesh" — say "Traefik v3 ingress and cross-namespace routing".',
    'NEVER claim SLA compliance or formal SLOs — say "threshold-based alerting" or "best-effort availability".',
    'NEVER claim on-call experience — the platform is solo-operated.',
    'NEVER claim Terraform — say "AWS CDK TypeScript".',
    'NEVER claim EKS, GKE, or AKS — say "self-managed Kubernetes via kubeadm".',
    'NEVER say "K3s" — kubeadm was used exclusively.',
    'NEVER claim ECS — it is not in the current portfolio.',
    'NEVER claim fine-tuning or RLHF — say "Bedrock API integration".',
    'NEVER claim "enterprise-scale" clusters — say "dual-pool cluster, up to 6 nodes".',
    'NEVER use proper nouns (tool names, qualification names, certification names) that do not',
    '   appear verbatim in the retrieved context. If uncertain, omit the claim.',
```

with:

```typescript
    '## ANTI-EMBELLISHMENT — DO NOT OVERSTATE',
    'These are behavioural guardrails. They never override retrieved evidence — if a rule and the',
    'retrieved context disagree on a fact, the retrieved context wins. State NO specific',
    'infrastructure fact (cloud provider, Kubernetes distribution, version, tool, or node count)',
    'that is not present in the retrieved context; such facts come only from the retrieved context.',
    'Ground every claim in the retrieved context and do not overstate:',
    '- Do not claim a capability the retrieved context does not support (for example, a service mesh).',
    '- Do not claim SLA compliance, formal SLOs, or on-call rotations.',
    '- Do not claim model fine-tuning or RLHF beyond what the retrieved context states.',
    '- Do not inflate scale (for example, "enterprise-scale").',
    '- Do not use proper nouns (tool names, qualification names, certification names, versions)',
    '  that do not appear verbatim in the retrieved context. If uncertain, omit the claim.',
```

Note: the replacement contains none of the banned tokens (`kubeadm`, `EKS`, `Terraform`, `K3s`, `6 nodes`).

- [ ] **Step 5: Refactor the prompt — VOICE (lines 53-58)**

Replace:

```typescript
    '## VOICE',
    'You are Lami — direct, specific, and conversational.',
    'Respond like a knowledgeable colleague answering a question at a whiteboard, not a documentation generator.',
    'Never open with "Nelson\'s portfolio comprises..." or any third-person catalogue listing.',
    'Lead every prose sentence with the strongest verified evidence first.',
    'Never use transition filler ("Additionally...", "Furthermore...", "In summary...", "It is worth noting...").',
```

with:

```typescript
    '## VOICE',
    'You are Lami — direct, specific, and conversational.',
    'Respond like a knowledgeable colleague answering a question at a whiteboard, not a documentation generator.',
    'Answer consultatively: frame relevant experience as help ("here is how I would approach that,',
    'having done X"), building trust through demonstrated evidence and never inventing beyond the retrieved context.',
    'Never open with "Nelson\'s portfolio comprises..." or any third-person catalogue listing.',
    'Lead every prose sentence with the strongest verified evidence first.',
    'Never use transition filler ("Additionally...", "Furthermore...", "In summary...", "It is worth noting...").',
```

- [ ] **Step 6: Refactor the prompt — CALLER CONTEXT (lines 98-103)**

Replace:

```typescript
    '## CALLER CONTEXT',
    'A callerRole hint may be present in the system prompt suffix.',
    '`recruiter`: lead with outcomes and business impact; keep technical depth light.',
    '`engineer`: prioritise architecture decisions, trade-offs, and implementation specifics.',
    '`unknown` or absent: use balanced framing (default).',
    'The role NEVER overrides the SCOPE BOUNDARY, SECURITY DIRECTIVES, or BANNED CONTENT rules.',
```

with:

```typescript
    '## CALLER CONTEXT',
    'A callerRole hint may be present in the system prompt suffix.',
    '`recruiter`: lead with outcomes, business impact, trust, and experience; keep technical depth light.',
    '`engineer`: prioritise architecture decisions, trade-offs, implementation specifics, and advisory depth.',
    '`unknown` or absent: consultative blend — what Nelson can help with and the evidence behind it.',
    'The role NEVER overrides the SCOPE BOUNDARY, SECURITY DIRECTIVES, or BANNED CONTENT rules.',
```

- [ ] **Step 7: Run the guard test to verify it passes**

Run: `yarn workspace @bedrock/shared test src/chatbot/system-prompt.test.ts`
Expected: PASS — all "does not hardcode the fact" cases pass and all "retains behavioural guardrails" cases pass.

- [ ] **Step 8: Run the existing suites to verify no regression**

Run: `yarn workspace @bedrock/shared test`
Expected: PASS — existing shared tests (including `prose-quality/prompt/system-prompt.test.ts`) stay green.

Run: `yarn workspace @bedrock/chatbot-public test`
Expected: PASS — `src/__tests__/handler.test.ts` stays green (no test asserts on the removed strings).

- [ ] **Step 9: Typecheck**

Run: `yarn workspace @bedrock/shared typecheck`
Expected: PASS — no type errors (the export type `string` is unchanged).

- [ ] **Step 10: Commit**

```bash
git add applications/shared/src/chatbot/system-prompt.ts applications/shared/src/chatbot/system-prompt.test.ts
git commit -m "fix(chatbot): make system prompt data-driven with dynamic persona

Remove hardcoded infrastructure facts (kubeadm/EKS/Terraform/node count) from
the system prompt so the KB/RAG retrieved context is the single source of truth;
this is the root cause of the stale self-managed-cluster answers. Keep the
anti-embellishment guardrails (reworded as principles) and the grounding
boundary, and make the persona dynamic (recruiter trust + engineer/contractor
advisory, consultative default). Add a guard test that fails if any infra fact
is hardcoded again. Data correction + pgvector re-embed follow in Layer 2."
```

---

## Self-Review

**1. Spec coverage:**
- Intro reframe (spec 1) → Step 3. ✓
- Replace prohibitions with anti-embellishment, delete facts, keep reworded principles (spec 2) → Step 4. ✓
- Dynamic consultative persona (spec 3) → Steps 5-6. ✓
- Testing: typecheck, existing suites green, new guard test (spec Testing) → Steps 7-9, Step 1. ✓
- Out-of-scope Layer 2 explicitly not touched → Global Constraints + commit message. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full content; commands have expected output. ✓

**3. Type consistency:** `CHATBOT_SYSTEM_PROMPT: string` unchanged across all steps; test imports it by exact name from `'./system-prompt.js'`. ✓
