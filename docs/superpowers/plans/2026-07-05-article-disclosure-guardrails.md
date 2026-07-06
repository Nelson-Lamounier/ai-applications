# Article Disclosure Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the article generator from publishing reachable identifiers, ungrounded/false security claims, and exploit how-to, using a deterministic lint gate backed by Writer-prompt discipline and an independent QA dimension.

**Architecture:** Three enforcement layers on the existing pipeline — (1) deterministic regex lint (`article-lint-rules.ts`) as the primary hard gate, honouring the `publishIdentifiers` allow-list and made publish-blocking in `run-pipeline.ts`; (2) Writer system-prompt rules (`writer-core-prompt.ts`, `blog-persona.ts`) to reduce how often the lint fires; (3) a 7th QA dimension "Security & Disclosure" (`qa-agent.ts`, `qa-persona.ts`, shared type) with a reject gate. The live published BFF article is the golden regression fixture.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Jest, Zod, AWS Bedrock Converse tool-use, Postgres (RDS), SSM port-forward.

## Global Constraints

- **Repo/branch:** `ai-applications`, worktree `.worktrees/article-disclosure-guardrails`, branch `feat/article-disclosure-guardrails` (off `develop`). PRs target `develop`.
- **Import specifiers:** intra-package imports use explicit `.js` extensions (ESM). Cross-package: `@bedrock/shared`.
- **Comments:** every new/changed symbol documents **why** (repo CLAUDE.md convention); file headers on new files.
- **Allow-list contract:** an identifier is permitted in prose iff `publishIdentifiers.some(a => value.includes(a))` — never widen this test.
- **Severity meaning:** `error` = mechanical, must not publish; `warn` = route to QA/human. Security-claim heuristics are `warn` (route, don't judge truth).
- **Gates before done (from repo root):** build `shared` first, then per-workspace `tsc --noEmit` and `jest`. Lint has pre-existing complexity errors unrelated to these files; do not expand scope to fix them.
- **RDS edits:** dev account `771826808455`, db `tucaken`, via SSM port-forward. Scope every write by `slug` + `author_id`; capture original `content_md` first. Content edits only, never schema.
- **QA weights must sum to 100.** Target: Technical Accuracy 25, Specificity & Result 20, Security & Disclosure 15, SEO 13, Content Quality 12, MDX Structure 8, Metadata Quality 7.

---

### Task 1: Extend `checkIdentifierLeaks` with reachable-identifier patterns

**Files:**
- Modify: `applications/article-pipeline/src/lint/article-lint-rules.ts` (the `patterns` array in `checkIdentifierLeaks`, ~L473-482)
- Test: `applications/article-pipeline/src/lint/article-lint-rules.test.ts`

**Interfaces:**
- Consumes: `checkIdentifierLeaks(source: string, allowlist?: string[]): Finding[]`, `Finding { rule, severity, message, line?, excerpt? }` (both existing).
- Produces: new finding rules `identifier-leak:public-hostname`, `identifier-leak:k8s-service-dns`, `identifier-leak:private-ip`, `identifier-leak:aws-network-id`. No signature change.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('identifier leaks'...)` block — locate it near the current `checkIdentifierLeaks` tests, ~L155-170)

```ts
it('flags the public hostname and the service-DNS:port that leaked in the BFF article', () => {
  const src =
    'The site reaches api.nelsonlamounier.com and calls ' +
    'public-api.public-api:3001 over cluster DNS.';
  const rules = checkIdentifierLeaks(src).map((f) => f.rule);
  expect(rules).toContain('identifier-leak:public-hostname');
  expect(rules).toContain('identifier-leak:k8s-service-dns');
});

it('flags private IPs/CIDRs and AWS network resource IDs', () => {
  const src = 'Ingress from 10.0.0.0/16 via sg-0a3858a82377815de in vpc-0abc1234.';
  const rules = checkIdentifierLeaks(src).map((f) => f.rule);
  expect(rules).toContain('identifier-leak:private-ip');
  expect(rules).toContain('identifier-leak:aws-network-id');
});

it('does NOT flag example domains or localhost (false-positive guard)', () => {
  const src = 'For local dev use localhost:3000; docs use example.com:443.';
  const rules = checkIdentifierLeaks(src).map((f) => f.rule);
  expect(rules).not.toContain('identifier-leak:k8s-service-dns');
});

it('allows a hostname that is explicitly on the publishIdentifiers allowlist', () => {
  const src = 'The public read API is served at api.nelsonlamounier.com.';
  const f = checkIdentifierLeaks(src, ['api.nelsonlamounier.com']);
  expect(f.map((x) => x.rule)).not.toContain('identifier-leak:public-hostname');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "identifier"`
Expected: FAIL — the new rules are not produced yet.

- [ ] **Step 3: Add the patterns** — extend the `patterns` array in `checkIdentifierLeaks` (keep the existing 5 entries; append these). Place a `continue`-guard for example domains/localhost right after the existing `allowlist.some(...)` check.

```ts
// inside checkIdentifierLeaks, patterns array — append:
{ name: 'public-hostname', re: /\b[a-z0-9-]+\.nelsonlamounier\.com\b/gi },
// service-DNS with a port: name.namespace(.svc(.cluster.local))?:port.
// The negative lookahead + TLD guard below keep public FQDNs and localhost out.
{ name: 'k8s-service-dns', re: /\b[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*(?:\.svc(?:\.cluster\.local)?)?:\d{2,5}\b/g },
{ name: 'private-ip', re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?:\/\d{1,2})?\b/g },
{ name: 'aws-network-id', re: /\b(?:sg|vpc|subnet|eni)-[0-9a-f]{8,}\b/g },
```

Then, inside the `for (const m of source.matchAll(p.re))` loop, immediately after `if (allowlist.some((a) => value.includes(a))) continue;`, add the false-positive guard:

```ts
// service-DNS pattern must not fire on public FQDNs or localhost — those are
// either caught by the hostname rule (and allow-listed there) or legitimate.
if (
  p.name === 'k8s-service-dns' &&
  (/^localhost:/i.test(value) || /\.(com|org|net|io|dev|app|co|ai):/i.test(value))
) {
  continue;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "identifier"`
Expected: PASS (all identifier tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add applications/article-pipeline/src/lint/article-lint-rules.ts applications/article-pipeline/src/lint/article-lint-rules.test.ts
git commit -m "feat(lint): flag reachable identifiers (hostnames, svc-dns, IPs, network IDs)"
```

---

### Task 2: Add `checkSecurityClaims` router (warn) and wire into `lintArticle`

**Files:**
- Modify: `applications/article-pipeline/src/lint/article-lint-rules.ts` (new exported function after `checkIdentifierLeaks`; add to `lintArticle` runner ~L570-579)
- Test: `applications/article-pipeline/src/lint/article-lint-rules.test.ts`

**Interfaces:**
- Consumes: `proseOnly(source): string` (existing), `Finding`.
- Produces: `checkSecurityClaims(source: string): Finding[]` — rule `security-claim-unverified`, severity `warn`. Added to `lintArticle`'s returned array.

- [ ] **Step 1: Write the failing test**

```ts
describe('security-claim router', () => {
  it('routes an attacker-limitation claim for human/QA review (warn, not error)', () => {
    const src =
      '## Security\nThis keeps the BFF and its secrets off the public surface, ' +
      'so the database is not reachable from the internet.';
    const f = checkSecurityClaims(src);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].rule).toBe('security-claim-unverified');
    expect(f[0].severity).toBe('warn');
  });

  it('does not flag neutral architecture prose', () => {
    const src = '## Design\nThe BFF fetches data over cluster DNS and returns JSON.';
    expect(checkSecurityClaims(src)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "security-claim"`
Expected: FAIL — `checkSecurityClaims is not a function`.

- [ ] **Step 3: Implement the router** (add after `checkIdentifierLeaks`, before Rule 9)

```ts
// ---------------------------------------------------------------------------
// Rule 8b — Security-posture claims (router, not judge)
// ---------------------------------------------------------------------------

/**
 * Flags prose that ASSERTS a protection ("off the public surface", "not
 * reachable", "cannot be accessed", "no credentials"). Regex cannot verify
 * whether such a claim is TRUE — the BFF article's "off the public surface"
 * was false — so this only routes the sentence to QA/human adjudication as a
 * `warn`. It never blocks and never asserts truth.
 */
export function checkSecurityClaims(source: string): Finding[] {
  const prose = proseOnly(source);
  const patterns: RegExp[] = [
    /\boff the public surface\b/gi,
    /\b(?:not|never|un)\s*reachable\b/gi,
    /\bcannot be (?:accessed|reached|exploited)\b/gi,
    /\bimpossible to (?:access|reach|exploit)\b/gi,
    /\bno (?:aws )?credentials?\b/gi,
    /\bhas no (?:public|internet) (?:access|exposure)\b/gi,
  ];
  const findings: Finding[] = [];
  for (const re of patterns) {
    for (const m of prose.matchAll(re)) {
      findings.push({
        rule: 'security-claim-unverified',
        severity: 'warn',
        message:
          `Security-posture claim "${m[0]}" — verify it is grounded in the KB ` +
          `and TRUE before publishing; describe what the code does, not what an ` +
          `attacker cannot do.`,
      });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Wire into `lintArticle`** — add to the returned array (after `checkIdentifierLeaks(source, allowlist)`):

```ts
    ...checkIdentifierLeaks(source, allowlist),
    ...checkSecurityClaims(source),
```

- [ ] **Step 5: Run to verify pass**

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "security-claim"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/article-pipeline/src/lint/article-lint-rules.ts applications/article-pipeline/src/lint/article-lint-rules.test.ts
git commit -m "feat(lint): route security-posture claims to review (warn)"
```

---

### Task 3: Make disclosure lint errors block publish in the pipeline

**Files:**
- Modify: `applications/article-pipeline/src/run-pipeline.ts` (the `articleStatus` computation, ~L511; `lintMeta` is already available from L496)

**Interfaces:**
- Consumes: `lintMeta?: { errors: number; warnings: number; findings: Finding[] }` (already produced by `lintArticleStructure`, L496), `gate.passed: boolean`, `articleStatusFor(passed: boolean)`.
- Produces: an article that carries a disclosure `identifier-leak:*` error is persisted as `flagged`, never `review`, regardless of QA score.

- [ ] **Step 1: Write the failing test** — create a focused unit for the decision. New file `applications/article-pipeline/src/lint/disclosure-gate.ts` holds the pure predicate so it is testable without Bedrock.

Test: `applications/article-pipeline/src/lint/disclosure-gate.test.ts`

```ts
import { describe, it, expect } from '@jest/globals';
import { hasDisclosureBlocker } from './disclosure-gate.js';

describe('hasDisclosureBlocker', () => {
  it('blocks when an identifier-leak error is present', () => {
    expect(hasDisclosureBlocker([
      { rule: 'identifier-leak:public-hostname', severity: 'error', message: 'x' },
    ])).toBe(true);
  });
  it('does not block on a warn-level security-claim finding', () => {
    expect(hasDisclosureBlocker([
      { rule: 'security-claim-unverified', severity: 'warn', message: 'x' },
    ])).toBe(false);
  });
  it('ignores unrelated error findings', () => {
    expect(hasDisclosureBlocker([
      { rule: 'dead-link', severity: 'error', message: 'x' },
    ])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/article-pipeline && npx jest src/lint/disclosure-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the predicate**

Create `applications/article-pipeline/src/lint/disclosure-gate.ts`:

```ts
/**
 * disclosure-gate.ts
 *
 * Pure predicate: does the structural-lint output contain a disclosure finding
 * that must HARD-BLOCK publish? Kept separate from run-pipeline.ts so it is unit
 * testable without Bedrock/RDS. Only `error`-severity identifier leaks block;
 * security-claim findings are `warn` (routed to QA, not blocking).
 */
import type { Finding } from './article-lint-rules.js';

/** True if any finding is an error-severity reachable-identifier leak. */
export function hasDisclosureBlocker(findings: readonly Finding[]): boolean {
  return findings.some(
    (f) => f.severity === 'error' && f.rule.startsWith('identifier-leak:'),
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd applications/article-pipeline && npx jest src/lint/disclosure-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `run-pipeline.ts`** — import the predicate and fold it into the status decision. Replace the single line at ~L511.

Add import near the other lint import (~L20):

```ts
import { hasDisclosureBlocker } from './lint/disclosure-gate.js';
```

Replace:

```ts
        const articleStatus = articleStatusFor(gate.passed);
```

with:

```ts
        // A confirmed reachable-identifier leak hard-blocks publish regardless of
        // the QA score: 'flagged' routes it to admin review instead of 'review'.
        const disclosureBlocked = hasDisclosureBlocker(lintMeta?.findings ?? []);
        const articleStatus = articleStatusFor(gate.passed && !disclosureBlocked);
```

- [ ] **Step 6: Typecheck + run pipeline unit tests**

Run: `cd applications/article-pipeline && npx tsc --noEmit && npx jest src/lint/`
Expected: PASS, tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add applications/article-pipeline/src/lint/disclosure-gate.ts applications/article-pipeline/src/lint/disclosure-gate.test.ts applications/article-pipeline/src/run-pipeline.ts
git commit -m "feat(pipeline): hard-block publish on reachable-identifier leaks"
```

---

### Task 4: Widen `OPERATIONAL IDENTIFIERS` + add `SECURITY-CLAIM DISCIPLINE` (Writer core)

**Files:**
- Modify: `applications/article-pipeline/src/prompts/writer-core-prompt.ts` (the `WRITER_CORE_RULES` template string, ~L77-92)

**Interfaces:**
- Consumes/Produces: none programmatic — this is prompt text inside `WRITER_CORE_RULES`. No exports change. (Prompt-cache busts once; expected.)

- [ ] **Step 1: Replace the `## OPERATIONAL IDENTIFIERS` block** with the widened list:

```ts
## OPERATIONAL IDENTIFIERS

Do not emit any concrete, reachable identifier unless it is listed in the
brief's publishIdentifiers. This covers: cluster names, namespaces, SSM paths,
ARNs, account/resource IDs, internal verification metadata, AND public
hostnames (\`api.example.com\`), Kubernetes service-DNS with ports
(\`svc.namespace:port\`, \`*.svc.cluster.local\`), private IPs/CIDRs
(10./172.16-31./192.168.), and network resource IDs (\`sg-\`, \`vpc-\`,
\`subnet-\`, \`eni-\`). Otherwise generalise them: \`<cluster-name>\`,
\`/k8s/<env>/...\`, \`<bff-host>\`, \`<service>.<namespace>:<port>\`, \`<cidr>\`,
\`<sg-id>\`. Never emit KB provenance metadata (e.g. "verified active <date>").
Describe architecture with real component NAMES (e.g. "the public-api BFF"),
but never its reachable ADDRESS unless whitelisted.
```

- [ ] **Step 2: Add a new `## SECURITY-CLAIM DISCIPLINE` block** immediately after it:

```ts
## SECURITY-CLAIM DISCIPLINE

- Claim a security property ONLY if a KB passage explicitly states it. Cite the
  mechanism ("the BFF holds the credentials"), never a guarantee.
- Describe what the code DOES; never assert what an attacker CANNOT do
  ("off the public surface", "unreachable", "impossible to access"). Those are
  claims you cannot verify and have been wrong before.
- Never publish step-by-step bypass, rate-limit-defeat, or auth-defeat detail.
  State that a control exists and what it protects, not how to beat it.
- If the KB is silent or self-contradictory about a security property, OMIT the
  claim rather than resolving it in the flattering direction.
```

- [ ] **Step 3: Add a `## READER CLARITY` block** immediately after SECURITY-CLAIM
  DISCIPLINE. These rules were validated by hand-correcting the live BFF article
  (spell-out acronyms; "application" over vague "site"; gloss internal service
  names for a non-expert reader). They are prose-clarity rules, not disclosure
  rules, but belong in the universal Writer layer:

```ts
## READER CLARITY

- Expand every acronym on FIRST use, then use the short form: "Backend-for-Frontend
  (BFF)", not a bare "BFF". Applies to product/domain acronyms a general reader
  may not know (BFF, RRF, ISR, IRSA); standard ones (AWS, API, SQL, JSON) need no
  expansion.
- Prefer concrete product nouns over vague ones: call it "the application" or the
  named service, not "the site", when describing a system with real backend
  behaviour.
- The first time you name an internal service, endpoint, framework helper, or API
  action a general reader would not recognise, add a short gloss of what it is
  (e.g. "`/api/chat` (the site's server-side route behind the chat widget)",
  "`secretsmanager:GetSecretValue` (the AWS API action that reads a secret)").
  One gloss per term, at first use only.
```

- [ ] **Step 4: Typecheck** (prompt is a plain string; verify the file still compiles)

Run: `cd applications/article-pipeline && npx tsc --noEmit`
Expected: exit 0 (build `applications/shared` first: `cd applications/shared && npx tsc -b`).

- [ ] **Step 5: Commit**

```bash
git add applications/article-pipeline/src/prompts/writer-core-prompt.ts
git commit -m "feat(writer-prompt): widen identifier rule, security-claim discipline, reader clarity"
```

---

### Task 5: Fix the KB-Augmented identifier contradiction in `blog-persona.ts`

**Files:**
- Modify: `applications/article-pipeline/src/prompts/blog-persona.ts` (the "Your Task in KB-Augmented Mode" bullet, ~L830-831)

**Interfaces:** none — prompt text only.

- [ ] **Step 1: Replace the contradicting bullet.** Current text ends the KB-Augmented section:

```ts
- Generate MermaidChart components based on architecture descriptions in the
  KB context — use the real resource names and identifiers found there.
```

Replace with:

```ts
- Generate MermaidChart components based on architecture descriptions in the
  KB context. Use real component NAMES (services, patterns), but GENERALISE any
  concrete identifier — hostnames, service-DNS:port, IPs, ARNs, resource IDs —
  that is not in the brief's publishIdentifiers, per OPERATIONAL IDENTIFIERS.
  A diagram must show the shape of the system, not its reachable addresses.
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/article-pipeline && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add applications/article-pipeline/src/prompts/blog-persona.ts
git commit -m "fix(writer-prompt): stop KB-mode from emitting real identifiers in diagrams"
```

---

### Task 6: Add the `securityDisclosure` QA dimension (type + agent schema + parse)

**Files:**
- Modify: `applications/shared/src/types.ts` (`QaValidationResult.dimensions`, ~L653-659)
- Modify: `applications/article-pipeline/src/agents/qa-agent.ts` (tool schema L119-130, Zod L157-164, parse L277-284)
- Test: `applications/article-pipeline/src/agents/qa-agent.test.ts`

**Interfaces:**
- Consumes: `DimensionResult` (existing), `QaDimensionSchema`, `QA_DIMENSION_SCHEMA`.
- Produces: `QaValidationResult.dimensions.securityDisclosure: DimensionResult`. The gate (`qa-gate.ts`) already iterates dimensions generically, so `recordAttempt`/`buildRevisionNotes` pick it up with no change.

- [ ] **Step 1: Write the failing test** — a parser test that a 7-dimension payload validates and surfaces the new dimension. Model it on the existing qa-agent parse tests (open the file to match the harness; the payload must include all 7 dimensions since the schema is `.strict()`).

```ts
it('parses the securityDisclosure dimension', () => {
  const payload = JSON.stringify({
    overallScore: 90, recommendation: 'reject',
    dimensions: {
      technicalAccuracy: { score: 90, issues: [] },
      seoCompliance: { score: 90, issues: [] },
      mdxStructure: { score: 90, issues: [] },
      metadataQuality: { score: 90, issues: [] },
      contentQuality: { score: 90, issues: [] },
      specificityAndResult: { score: 90, issues: [] },
      securityDisclosure: { score: 10, issues: [
        { severity: 'error', location: 'Diagram', description: 'leaks api host', fix: 'generalise' },
      ] },
    },
    summary: 's', confidenceOverride: 80,
  });
  const result = parseQaResponse(payload); // export it if not already
  expect(result.dimensions.securityDisclosure.score).toBe(10);
  expect(result.recommendation).toBe('reject');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd applications/article-pipeline && npx jest src/agents/qa-agent.test.ts -t "securityDisclosure"`
Expected: FAIL — `.strict()` rejects the unknown key / property missing.

- [ ] **Step 3: Add the dimension to the shared type** — in `applications/shared/src/types.ts`, inside `QaValidationResult.dimensions`, after `specificityAndResult`:

```ts
        readonly specificityAndResult: DimensionResult;
        /** Leaked identifiers, ungrounded/false security claims, or exploit how-to. */
        readonly securityDisclosure: DimensionResult;
```

- [ ] **Step 4: Add to the Bedrock tool schema** (`qa-agent.ts`): in `QA_TOOL.inputSchema...dimensions.properties` add `securityDisclosure: QA_DIMENSION_SCHEMA,`, and add `'securityDisclosure'` to that object's `required` array. Update the tool `description` to say "seven dimensions".

- [ ] **Step 5: Add to the Zod schema** (`qa-agent.ts`, `QaOutputSchema.dimensions`): add `securityDisclosure: QaDimensionSchema,` (keep `.strict()`).

- [ ] **Step 6: Add to `parseQaResponse`** dimensions mapping: `securityDisclosure: clampDimension(d.dimensions.securityDisclosure),`. If `parseQaResponse` is not exported, add `export` so the test can call it.

- [ ] **Step 7: Build shared, then run to verify pass**

Run: `cd applications/shared && npx tsc -b && cd ../article-pipeline && npx jest src/agents/qa-agent.test.ts -t "securityDisclosure"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add applications/shared/src/types.ts applications/article-pipeline/src/agents/qa-agent.ts applications/article-pipeline/src/agents/qa-agent.test.ts
git commit -m "feat(qa): add securityDisclosure dimension to schema + type + parser"
```

---

### Task 7: QA persona — dimension prose, weight rebalance, reject gate

**Files:**
- Modify: `applications/article-pipeline/src/prompts/qa-persona.ts` (dimensions block, Output Format example, Scoring Rules)

**Interfaces:** none programmatic — persona prose consumed by the QA agent. The `reject` it emits is already honoured by `qaPassed` (`recommendation !== 'reject'`), so no gate code changes.

- [ ] **Step 1: Add the 7th dimension** after "### 6. Specificity & Result (weight: 20%)" block:

```ts
            ``,
            `### 7. Security & Disclosure (weight: 15%)`,
            `The article must not become an attack map or make a false safety claim.`,
            `Flag each as severity "error":`,
            `- **Leaked identifier**: a real public hostname, Kubernetes service-DNS`,
            `  with a port, private IP/CIDR, or sg-/vpc-/subnet-/eni- ID that is NOT`,
            `  in the brief's publishIdentifiers. Generalising it is the fix.`,
            `- **Ungrounded/false security claim**: asserts a protection not stated in`,
            `  the KB, or asserts what an attacker CANNOT do ("off the public surface",`,
            `  "unreachable") rather than what the code does.`,
            `- **Exploit how-to**: step-by-step bypass, rate-limit-defeat, or auth-defeat`,
            `  detail. Describing that a control exists is fine; how to beat it is not.`,
```

- [ ] **Step 2: Rebalance the six existing weights** in their headings so all seven sum to 100: Technical Accuracy `30%`→`25%`, SEO `15%`→`13%`, MDX `10%`→`8%`, Metadata `10%`→`7%`, Content `15%`→`12%`, Specificity stays `20%`, Security `15%`. (Edit each `(weight: N%)` heading string.)

- [ ] **Step 3: Add the hard reject gate** to `## Scoring Rules`, under `recommendation`, after the Specificity gate bullet:

```ts
            `  - **Security & Disclosure gate**: if Security & Disclosure has ANY`,
            `    "error" issue (a leaked identifier, an ungrounded/false security`,
            `    claim, or exploit how-to), set recommendation to \`"reject"\``,
            `    regardless of overallScore. A single disclosure error is`,
            `    disqualifying — it cannot be published and revised into safety by`,
            `    scoring alone.`,
```

- [ ] **Step 4: Update the Output Format example** — add a `securityDisclosure` entry to the `dimensions` object and update the overallScore weight note in `## Scoring Rules` to list all seven weights.

```ts
            `    "securityDisclosure": {`,
            `      "score": 100,`,
            `      "issues": []`,
            `    }`,
```

And update the weights line:

```ts
            `- **overallScore**: Weighted average of all 7 dimension scores (Technical`,
            `  Accuracy 25%, Specificity & Result 20%, Security & Disclosure 15%, SEO`,
            `  13%, Content Quality 12%, MDX Structure 8%, Metadata Quality 7%)`,
```

- [ ] **Step 5: Typecheck**

Run: `cd applications/article-pipeline && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add applications/article-pipeline/src/prompts/qa-persona.ts
git commit -m "feat(qa-prompt): Security & Disclosure dimension + reject gate + reweight"
```

---

### Task 8: Golden regression fixture from the corrected BFF article

**Files:**
- Create: `applications/article-pipeline/src/lint/__fixtures__/bff-article-leaky.md` (the ORIGINAL leaky prose excerpt) and `.../bff-article-clean.md` (the corrected excerpt from the in-place edits).
- Test: `applications/article-pipeline/src/lint/article-lint-rules.test.ts` (a regression block)

**Interfaces:** consumes `lintArticle(source, fm)` and `hasDisclosureBlocker`.

- [ ] **Step 1: Write the regression test** — the leaky excerpt must flag a disclosure blocker; the corrected excerpt must not.

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintArticle } from './article-lint-rules.js';
import { hasDisclosureBlocker } from './disclosure-gate.js';

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');

describe('BFF article golden regression', () => {
  it('the original leaky text is disclosure-blocked', () => {
    const findings = lintArticle(fx('bff-article-leaky.md'), { title: 'BFF' });
    expect(hasDisclosureBlocker(findings)).toBe(true);
  });
  it('the corrected text passes the disclosure gate', () => {
    const findings = lintArticle(fx('bff-article-clean.md'), {
      title: 'BFF', publishIdentifiers: [],
    });
    expect(hasDisclosureBlocker(findings)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** (fixtures absent)

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "golden regression"`
Expected: FAIL — ENOENT on the fixtures.

- [ ] **Step 3: Create the fixtures** — `bff-article-leaky.md` is the pre-fix excerpt (contains `api.nelsonlamounier.com`, `public-api.public-api:3001`, "off the public surface"); `bff-article-clean.md` is the corrected excerpt produced during the in-place RDS iteration (Validation Loop). Paste the exact approved before/after text.

- [ ] **Step 4: Run to verify pass**

Run: `cd applications/article-pipeline && npx jest src/lint/article-lint-rules.test.ts -t "golden regression"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/article-pipeline/src/lint/__fixtures__ applications/article-pipeline/src/lint/article-lint-rules.test.ts
git commit -m "test(lint): golden regression from the BFF article (leaky vs clean)"
```

---

### Validation Loop: iterate the live BFF article in place (interactive, user-gated)

Run **once per guardrail**, interleaved with Tasks 1–7. This is not TDD; each iteration is gated on user approval and touches the live dev DB.

**Preconditions:** SSM tunnel open per `frontend-portfolio/docs/runbooks/rds-migration-via-ssm-tunnel.md` (local 15440 → RDS 5432); `PGPASSWORD` from `k8s-development/platform-rds/credentials`; `CONN="host=127.0.0.1 port=15440 dbname=tucaken user=postgres sslmode=require connect_timeout=5"`; article `slug = retire-all-direct-aws-data-plane-calls-become-a-pure-bff-consumer`.

- [ ] **Step 1: Snapshot the current body (reversibility)**

```bash
psql "$CONN" -tA -c "select content_md from articles where slug='retire-all-direct-aws-data-plane-calls-become-a-pure-bff-consumer'" > /tmp/bff-article.$(git rev-parse --short HEAD).md
```

- [ ] **Step 2: Produce the corrected `content_md`** for THIS guardrail (e.g. generalise the hostname → `<bff-host>` or remove the "off the public surface" sentence). Write the full corrected body to a scratch file; show the user a unified diff (`diff <old> <new>`).

- [ ] **Step 3: User approves the in-place change.** Do not proceed without it.

- [ ] **Step 4: Apply in place** (scoped by slug; body-only)

```bash
psql "$CONN" -v ON_ERROR_STOP=1 \
  -c "update articles set content_md = \$md\$$(cat /tmp/corrected.md)\$md\$, updated_at = now() where slug='retire-all-direct-aws-data-plane-calls-become-a-pure-bff-consumer'"
```

- [ ] **Step 5: Encode upstream.** Translate the approved correction into the matching Task (1/2/4/5/7) rule if not already covered, and fold the approved before/after into the Task 8 fixtures.

- [ ] **Step 6: Close the tunnel** when the iteration set is done.

---

## Self-Review

**Spec coverage:**
- Layer 1 lint (identifier patterns) → Task 1. Security-claim router → Task 2. Publish-blocking → Task 3. ✓
- Layer 2 Writer prompt (widen identifiers + security-claim discipline) → Task 4; blog-persona:831 fix → Task 5. ✓
- Layer 3 QA (new dimension schema/type/parse) → Task 6; persona prose + weights + reject gate → Task 7. ✓
- Validation methodology (in-place article + golden fixture) → Validation Loop + Task 8. ✓
- Weight rebalance sums to 100 (25+20+15+13+12+8+7) → Task 7. ✓

**Placeholder scan:** every code step carries real code; fixtures in Task 8 are filled from the approved in-place edits (Validation Loop Step 5), which is a data dependency, not a placeholder.

**Type consistency:** `securityDisclosure: DimensionResult` is added in the shared type (Task 6 Step 3), the Bedrock tool schema, the Zod schema, and `parseQaResponse` in the same task; `hasDisclosureBlocker(findings)` defined in Task 3 and reused in Task 8 with the same signature; `checkSecurityClaims(source)` defined in Task 2 and wired in the same task.

**Order dependency:** Task 8 fixtures depend on the Validation Loop having produced approved corrected text; run at least one Validation iteration before Task 8 Step 3.
