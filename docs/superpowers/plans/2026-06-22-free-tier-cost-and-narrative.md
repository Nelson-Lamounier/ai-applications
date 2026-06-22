# Free-Tier Cost Recording + Narrative Uplift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-run LLM cost+tokens for free AND paid strategist runs, and lift the free resume's narrative with cheap DB-read commit/PR + profile-intelligence evidence and a positioning-led persona — no new LLM calls.

**Architecture:** `extractJdSignal` gains an optional shared pipeline context so its cost is captured. The free orchestrator threads one context through extraction + writer + grounding and persists `metadata.costUsd`/`tokens` (case-study shape); the paid path does the same. Two new fail-open DB loaders (commit/PR evidence, profile-intelligence) extend `FreeEvidence`; the free writer's envelope + persona use them; the grader + eval enforce shipped-work citation + a positioning line + no fabrication.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Jest (`@jest/globals`), Bedrock via `runAgent`, Postgres (`pg`).

## Global Constraints

- **No new LLM calls** in the free path (still: 1 extraction + RAG embeds/rerank + 1 writer + flag-mode grounding verifier). The two new loaders are pure DB reads.
- **Anti-hallucination holds:** commits/PRs and career facts are citable evidence; profile-intelligence seniority is a *positioning aid only* — never a source for invented metrics.
- **Cost shape mirrors the case-study pipeline:** `metadata.tokens = { input, output, thinking }`, `metadata.costUsd = <number>`. The figure is **LLM-agent cost** (extraction + writer [+ grounding]); embeddings/rerank are excluded (documented in a code comment).
- **Fail-open:** both new loaders return `''` on any error/empty; `extractJdSignal`'s ctx param is optional (absent → today's ephemeral context).
- **Paid behaviour unchanged** except additive cost metadata.
- English (UK); `applications/` complexity ceiling 10; ESLint + `yarn tsc --noEmit` clean; no migration. No "Co-Authored-By: Claude" trailer; commit bodies as impact bullets.
- **Branch:** `spec/free-tier-cost-and-narrative` (off develop). Tests from `applications/job-strategist`: `yarn test <path>`.

---

## File Structure

- **Modify** `applications/job-strategist/src/agents/jd-extractor.ts` — `extractJdSignal(jobDescription, ctx?)`; alias forwards ctx.
- **Create** `applications/job-strategist/src/free/commit-pr-evidence.ts` — `loadCommitPrEvidence(pool, userId)`.
- **Create** `applications/job-strategist/src/free/commit-pr-evidence.test.ts`.
- **Create** `applications/job-strategist/src/free/profile-intelligence.ts` — `loadProfilePositioning(pool, userId)`.
- **Create** `applications/job-strategist/src/free/profile-intelligence.test.ts`.
- **Modify** `applications/job-strategist/src/free/gather-evidence.ts` — `FreeEvidence` + two new fields; wire loaders.
- **Modify** `applications/job-strategist/src/free/gather-evidence.test.ts`.
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.ts` — `buildUserMessage` blocks; `gradeFreeResume` positioning + shipped-work checks; `FreeWriterInput` unchanged (evidence carries the new fields).
- **Modify** `applications/job-strategist/src/prompts/free-resume-persona.ts` — positioning lead + shipped-work emphasis.
- **Modify** `applications/job-strategist/src/agents/free-resume-writer.test.ts` and `free-resume-writer.eval.test.ts`.
- **Modify** `applications/job-strategist/src/free/run-free.ts` — thread ctx; persist cost.
- **Modify** `applications/job-strategist/src/free/run-free.test.ts`.
- **Modify** `applications/job-strategist/src/run-pipeline.ts` — pass ctx to `extractJobDescription`; persist cost on the final metadata write.

---

## Task 1: `extractJdSignal` accepts an optional shared context

**Files:**
- Modify: `applications/job-strategist/src/agents/jd-extractor.ts`
- Test: `applications/job-strategist/src/agents/jd-extractor.test.ts`

**Interfaces:**
- Produces: `extractJdSignal(jobDescription: string, ctx?: BasePipelineContext): Promise<JdSignal>`; `extractJobDescription` forwards `ctx`.

- [ ] **Step 1: Write the failing test**

Add to `jd-extractor.test.ts` (the file already mocks `runAgent`):

```typescript
import type { BasePipelineContext } from '@bedrock/shared';

it('accumulates extraction cost into a supplied pipeline context', async () => {
    // The existing runAgent mock returns a fixed result; make it also accumulate
    // like the real runAgent so this asserts the ctx is threaded (not replaced).
    (runAgent as jest.Mock).mockImplementationOnce(async ({ pipelineContext }: { pipelineContext: BasePipelineContext }) => {
        pipelineContext.cumulativeCostUsd += 0.42;
        pipelineContext.cumulativeTokens.input += 100;
        return { data: { ...MINIMAL_FIXTURE }, tokenUsage: { inputTokens: 100, outputTokens: 0, thinkingTokens: 0 }, costUsd: 0.42 } as never;
    });
    const ctx: BasePipelineContext = { pipelineId: 'p', environment: 'test', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };
    await extractJdSignal('Senior Platform Engineer — Kubernetes, AWS.', ctx);
    expect(ctx.cumulativeCostUsd).toBeCloseTo(0.42);
    expect(ctx.cumulativeTokens.input).toBe(100);
});
```

(Use the file's existing fixture for `MINIMAL_FIXTURE`/the mock shape — match how the other `extractJdSignal` tests stub `runAgent`. If the existing mock is a module factory, extend it to honour `pipelineContext` mutation for this one case.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/jd-extractor.test.ts -t "supplied pipeline context"`
Expected: FAIL — `extractJdSignal` ignores the ctx (uses its own).

- [ ] **Step 3: Implement**

In `jd-extractor.ts`, change the signature and use the supplied ctx when present:

```typescript
export async function extractJdSignal(
    jobDescription: string,
    ctx?: BasePipelineContext,
): Promise<JdSignal> {
    const safe = piiScrubber.scrub(jobDescription).redacted.slice(0, MAX_JD_CHARS);
    if (safe.trim().length === 0) return { ...MINIMAL_JD_SIGNAL };

    const config: AgentConfig = { /* …unchanged… */ };
    // Use the caller's run context so extraction cost is captured; fall back to a
    // throwaway context for standalone callers (back-compat).
    const pipelineContext: BasePipelineContext = ctx ?? {
        pipelineId:        'jd-extract',
        environment:       process.env['DEPLOY_ENV'] ?? 'dev',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };
    try {
        const result = await runAgent<JdSignal>({ config, userMessage: `<job_description>\n${safe}\n</job_description>`, pipelineContext, parseResponse: /* …unchanged… */ });
        // …unchanged…
    } catch (e) { /* …unchanged fail-open… */ }
}
```

Find the `extractJobDescription` back-compat alias (same file, ~line 311) and forward the ctx: `export const extractJobDescription = (jd: string, ctx?: BasePipelineContext) => extractJdSignal(jd, ctx);` (match the real alias form).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/agents/jd-extractor.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/jd-extractor.ts src/agents/jd-extractor.test.ts
git add applications/job-strategist/src/agents/jd-extractor.ts applications/job-strategist/src/agents/jd-extractor.test.ts
git commit -m "feat(strategist): extractJdSignal accepts an optional shared pipeline context

Captures JD-extraction cost into the caller's run context (free + paid both lost
it via a throwaway context). Optional — absent → today's ephemeral behaviour."
```

---

## Task 2: commit/PR evidence loader

**Files:**
- Create: `applications/job-strategist/src/free/commit-pr-evidence.ts`
- Test: `applications/job-strategist/src/free/commit-pr-evidence.test.ts`

**Interfaces:**
- Produces: `loadCommitPrEvidence(pool: Pool, userId: string): Promise<string>` — a formatted block (or `''`).

- [ ] **Step 1: Write the failing test (fake pool dispatching on SQL)**

```typescript
/** @format */
import { loadCommitPrEvidence } from './commit-pr-evidence.js';

function makePool(rows: { pulls?: unknown[]; commits?: unknown[] }) {
    return {
        query: async (sql: string) => {
            if (/FROM repo_pull_requests/.test(sql)) return { rows: rows.pulls ?? [] };
            if (/FROM repo_commits/.test(sql)) return { rows: rows.commits ?? [] };
            return { rows: [] };
        },
    } as never;
}

describe('loadCommitPrEvidence', () => {
    it('formats merged PRs and authored commits into a shipped-work block', async () => {
        const out = await loadCommitPrEvidence(makePool({
            pulls: [{ repo_full_name: 'me/app', number: 12, title: 'feat(ingestion): enable controlled-vocabulary enrichment in production' }],
            commits: [{ repo_full_name: 'me/app', message: 'feat(enrichment): content-hash dedup cache — skip Haiku for unchanged chunks' }],
        }), 'u1');
        expect(out).toContain('Shipped work');
        expect(out).toContain('controlled-vocabulary enrichment');
        expect(out).toContain('#12');
        expect(out).toContain('content-hash dedup cache');
    });

    it('returns empty string on no rows (fail-open)', async () => {
        expect(await loadCommitPrEvidence(makePool({}), 'u1')).toBe('');
    });

    it('returns empty string when the query throws', async () => {
        const pool = { query: async () => { throw new Error('db down'); } } as never;
        expect(await loadCommitPrEvidence(pool, 'u1')).toBe('');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/commit-pr-evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * Free-tier commit/PR evidence — the candidate's own shipped work from
 * repo_commits / repo_pull_requests (populated by ingestion; pure DB read, no
 * GitHub network, no LLM). PR titles are conventional-commit, impact-describing
 * and read as ready-made resume bullets. Authored-only: commits are filtered to
 * the user's dominant author_login so the writer can claim them first-person.
 * Fail-open to '' so a thin/absent history never blocks generation.
 */
import type { Pool } from 'pg';

const PR_CAP = 8;
const COMMIT_CAP = 12;

interface PrRow { repo_full_name: string; number: number; title: string }
interface CommitRow { repo_full_name: string; message: string }

export async function loadCommitPrEvidence(pool: Pool, userId: string): Promise<string> {
    try {
        // Recent merged PRs first (open/unmerged last); these are the user's own
        // repos so they are the user's PRs.
        const pulls = (await pool.query<PrRow>(
            `SELECT repo_full_name, number, title
               FROM repo_pull_requests
              WHERE user_id = $1
              ORDER BY merged_at DESC NULLS LAST
              LIMIT $2`,
            [userId, PR_CAP],
        )).rows;

        // Commits by the dominant author_login (the user), longest/most-recent
        // messages first; skip ambiguous co-author/bot commits.
        const commits = (await pool.query<CommitRow>(
            `SELECT repo_full_name, message
               FROM repo_commits
              WHERE user_id = $1
                AND author_login = (
                    SELECT author_login FROM repo_commits
                     WHERE user_id = $1 AND author_login IS NOT NULL
                     GROUP BY author_login ORDER BY count(*) DESC LIMIT 1)
              ORDER BY authored_at DESC
              LIMIT $2`,
            [userId, COMMIT_CAP],
        )).rows;

        if (pulls.length === 0 && commits.length === 0) return '';

        const lines: string[] = ['Shipped work (the candidate\'s own pull requests & commits — citable evidence):'];
        for (const p of pulls) lines.push(`- ${p.repo_full_name}: PR "${p.title}" (#${p.number})`);
        for (const c of commits) lines.push(`- ${c.repo_full_name}: commit "${c.message.split('\n')[0]}"`);
        return lines.join('\n');
    } catch {
        return '';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/free/commit-pr-evidence.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/commit-pr-evidence.ts src/free/commit-pr-evidence.test.ts
git add applications/job-strategist/src/free/commit-pr-evidence.ts applications/job-strategist/src/free/commit-pr-evidence.test.ts
git commit -m "feat(strategist): free-tier commit/PR shipped-work evidence loader

Pure DB read of repo_pull_requests + repo_commits (dominant-author commits),
formatted as citable shipped-work evidence; fail-open to empty."
```

---

## Task 3: profile-intelligence positioning loader

**Files:**
- Create: `applications/job-strategist/src/free/profile-intelligence.ts`
- Test: `applications/job-strategist/src/free/profile-intelligence.test.ts`

**Interfaces:**
- Produces: `loadProfilePositioning(pool: Pool, userId: string): Promise<string>` — a positioning block (or `''`).

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { loadProfilePositioning } from './profile-intelligence.js';

function makePool(direction: unknown) {
    return { query: async () => ({ rows: direction === undefined ? [] : [{ direction }] }) } as never;
}

describe('loadProfilePositioning', () => {
    it('formats the strongest seniority areas with evidence', async () => {
        const out = await loadProfilePositioning(makePool({
            seniority: [
                { area: 'Platform & Kubernetes Engineering', level: 'senior', evidence: 'EKS, Karpenter, ArgoCD across 3 repos' },
                { area: 'Cloud Infrastructure (AWS)', level: 'senior', evidence: 'VPC, IAM, WAF' },
            ],
        }), 'u1');
        expect(out).toContain('Positioning signal');
        expect(out).toContain('Platform & Kubernetes Engineering: senior');
        expect(out).toContain('EKS, Karpenter');
    });

    it('returns empty string when no rollup row exists (fail-open)', async () => {
        expect(await loadProfilePositioning(makePool(undefined), 'u1')).toBe('');
    });

    it('returns empty string when direction has no seniority', async () => {
        expect(await loadProfilePositioning(makePool({}), 'u1')).toBe('');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/profile-intelligence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * Free-tier positioning signal — the candidate's code-grounded per-area
 * seniority from user_profile_rollup.direction (pure DB read, no LLM). A
 * POSITIONING aid only: it shapes how the writer frames the candidate's
 * identity; it is NEVER a source for fabricated metrics. Fail-open to ''.
 */
import type { Pool } from 'pg';

const AREA_CAP = 4;

interface Seniority { area: string; level: string; evidence?: string }

export async function loadProfilePositioning(pool: Pool, userId: string): Promise<string> {
    try {
        const row = (await pool.query<{ direction: { seniority?: Seniority[] } | null }>(
            `SELECT direction FROM user_profile_rollup WHERE user_id = $1`,
            [userId],
        )).rows[0];
        const seniority = row?.direction?.seniority ?? [];
        if (seniority.length === 0) return '';

        const lines = ['Positioning signal (code-grounded seniority — use to FRAME the candidate, not to invent metrics):'];
        for (const s of seniority.slice(0, AREA_CAP)) {
            const ev = s.evidence ? ` — ${s.evidence.split('\n')[0].slice(0, 240)}` : '';
            lines.push(`- ${s.area}: ${s.level}${ev}`);
        }
        return lines.join('\n');
    } catch {
        return '';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/free/profile-intelligence.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/profile-intelligence.ts src/free/profile-intelligence.test.ts
git add applications/job-strategist/src/free/profile-intelligence.ts applications/job-strategist/src/free/profile-intelligence.test.ts
git commit -m "feat(strategist): free-tier profile-intelligence positioning loader

Pure DB read of user_profile_rollup.direction.seniority → a positioning block
(framing aid only, not a metric source); fail-open to empty."
```

---

## Task 4: extend `FreeEvidence` + `gatherFreeEvidence`

**Files:**
- Modify: `applications/job-strategist/src/free/gather-evidence.ts`
- Test: `applications/job-strategist/src/free/gather-evidence.test.ts`

**Interfaces:**
- Consumes: `loadCommitPrEvidence` (Task 2), `loadProfilePositioning` (Task 3).
- Produces: `FreeEvidence` gains `commitPrEvidence: string` and `profileIntelligence: string`.

- [ ] **Step 1: Update the test to expect the new fields**

In `gather-evidence.test.ts`, extend the existing assertions so the returned `FreeEvidence` has `commitPrEvidence` and `profileIntelligence` strings (default `''` with the empty fake pool). Add to the existing empty-pool test:

```typescript
expect(typeof ev.commitPrEvidence).toBe('string');
expect(typeof ev.profileIntelligence).toBe('string');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts`
Expected: FAIL — properties absent / type error.

- [ ] **Step 3: Implement**

In `gather-evidence.ts`:
- Add imports: `import { loadCommitPrEvidence } from './commit-pr-evidence.js';` and `import { loadProfilePositioning } from './profile-intelligence.js';`
- Extend the interface:
```typescript
export interface FreeEvidence {
    readonly kbPassages: string[];
    readonly projectEvidence: string;
    readonly extractedTech: string;
    readonly careerFacts: string;
    readonly educationFacts: string;
    readonly commitPrEvidence: string;
    readonly profileIntelligence: string;
}
```
- Add the two loaders to the `Promise.all` (both already fail-open internally) and return them:
```typescript
    const [passageGroups, projectEvidence, careerEntries, educationEntries, codeTechByRepo, commitPrEvidence, profileIntelligence] =
        await Promise.all([
            Promise.all([deps.retrieve(q.skill), deps.retrieve(q.experience), deps.retrieve(q.project)]),
            loadProjectEvidenceBlock(pool, env.userId).catch(() => ''),
            loadCareerHistory(pool, env.userId).catch(() => []),
            loadEducation(pool, env.userId).catch(() => []),
            new TechnologyOntologyRepository(pool).loadRepoCodeTech(env.userId).catch(() => new Map<string, Set<string>>()),
            loadCommitPrEvidence(pool, env.userId),
            loadProfilePositioning(pool, env.userId),
        ]);
    // …existing kbPassages/extractedTech/careerFacts/educationFacts…
    return { kbPassages, projectEvidence, extractedTech, careerFacts, educationFacts, commitPrEvidence, profileIntelligence };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/gather-evidence.ts src/free/gather-evidence.test.ts
git add applications/job-strategist/src/free/gather-evidence.ts applications/job-strategist/src/free/gather-evidence.test.ts
git commit -m "feat(strategist): add commit/PR + profile-intelligence to FreeEvidence

Wires the two new fail-open DB loaders into gatherFreeEvidence; no new LLM calls."
```

---

## Task 5: writer envelope + persona + grader + eval (narrative uplift)

**Files:**
- Modify: `applications/job-strategist/src/agents/free-resume-writer.ts`
- Modify: `applications/job-strategist/src/prompts/free-resume-persona.ts`
- Test: `applications/job-strategist/src/agents/free-resume-writer.test.ts`, `free-resume-writer.eval.test.ts`

**Interfaces:**
- Consumes: `FreeEvidence.commitPrEvidence`, `.profileIntelligence` (Task 4).
- Produces: `gradeFreeResume` additionally checks a positioning lead + shipped-work usage.

- [ ] **Step 1: Write failing grader tests**

In `free-resume-writer.test.ts`, add (align fixtures to the real `FreeEvidence`/`FreeResumeOutput` — `evidence` now has `commitPrEvidence`/`profileIntelligence`):

```typescript
it('gradeFreeResume flags a summary with no positioning lead when positioning evidence exists', () => {
    const ev = { ...EV, profileIntelligence: 'Positioning signal: Platform & Kubernetes Engineering: senior' };
    const bad = { ...GOOD, resume: { ...GOOD.resume, summary: 'I did some things at a company.' } } as never;
    expect(gradeFreeResume(bad, ev).failures.some((f) => /positioning/i.test(f))).toBe(true);
});
it('gradeFreeResume passes when the summary opens with a positioning line', () => {
    const ev = { ...EV, profileIntelligence: 'Positioning signal: Platform & Kubernetes Engineering: senior' };
    const good = { ...GOOD, resume: { ...GOOD.resume, summary: 'Senior Platform & Kubernetes engineer who ships grounded tooling.' } } as never;
    expect(gradeFreeResume(good, ev).pass).toBe(true);
});
```

(Reuse the file's existing `GOOD`/`EV` fixtures; extend `EV` with `commitPrEvidence: ''`, `profileIntelligence: ''` so the base fixture still type-checks and the positioning check is a no-op when no positioning evidence is present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts -t positioning`
Expected: FAIL — `gradeFreeResume` has no positioning check.

- [ ] **Step 3: Implement the grader check + envelope + persona**

In `free-resume-writer.ts`:
- `buildUserMessage` — add the two evidence blocks inside `<evidence>` (only when non-empty):
```typescript
        evidence.commitPrEvidence ? `<commit_pr_evidence>\n${evidence.commitPrEvidence}\n</commit_pr_evidence>` : '',
        evidence.profileIntelligence ? `<positioning_signal>\n${evidence.profileIntelligence}\n</positioning_signal>` : '',
```
- `gradeFreeResume` — add a **positioning** check (keep the function flat; extract a helper): when `evidence.profileIntelligence` is non-empty, the summary's first sentence must contain a role/seniority cue. Implement:
```typescript
const SENIORITY_CUE = /\b(senior|staff|lead|principal|engineer|architect|specialist)\b/i;
// inside gradeFreeResume, after the existing checks:
if (evidence.profileIntelligence.trim().length > 0) {
    const firstSentence = (out.resume.summary.split(/[.!?]/)[0] ?? '').trim();
    if (!SENIORITY_CUE.test(firstSentence)) {
        failures.push('summary does not open with a positioning line (role/seniority) despite positioning evidence');
    }
}
```
  (Change `gradeFreeResume`'s signature to `gradeFreeResume(out, evidence)` — it already receives evidence; confirm and adjust call-sites in the tests + eval.)

In `free-resume-persona.ts` (`FREE_RESUME_SYSTEM_PROMPT`), add, prompt-only:
- *"Open the summary with ONE positioning line naming the candidate's strongest role identity for THIS role, anchored in `<positioning_signal>` (seniority areas) and the company's problem. Keep it tight."*
- *"Prefer the candidate's own shipped work: when `<commit_pr_evidence>` supports a bullet, ground it in that concrete PR/commit and name the work (e.g. 'shipped X (PR #NN)'). `<positioning_signal>` frames identity only — it is NOT a source for numbers or claims; never invent metrics from it."*
- Keep the existing impact-bullet + anti-hallucination rules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the eval**

In `free-resume-writer.eval.test.ts`, add a fixture with `commitPrEvidence` + `profileIntelligence` populated and assert: (a) the good fixture (positioning-led summary, a highlight referencing a PR/commit phrase) passes all graders; (b) a non-positioned summary fails the positioning check; (c) a fabricated metric/employer still fails. Reuse the existing eval style.

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.eval.test.ts`
Expected: PASS.

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.ts src/prompts/free-resume-persona.ts src/agents/free-resume-writer.test.ts src/agents/free-resume-writer.eval.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.ts applications/job-strategist/src/prompts/free-resume-persona.ts applications/job-strategist/src/agents/free-resume-writer.test.ts applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "feat(strategist): positioning-led free persona + shipped-work grounding + eval

Writer envelope carries commit/PR + positioning signal; persona opens with a
positioning line and grounds bullets in real PRs/commits (positioning is a
framing aid, never a metric source); grader + eval enforce it. No new LLM calls."
```

---

## Task 6: thread cost through free + paid and persist it

**Files:**
- Modify: `applications/job-strategist/src/free/run-free.ts`
- Modify: `applications/job-strategist/src/run-pipeline.ts`
- Test: `applications/job-strategist/src/free/run-free.test.ts`

**Interfaces:**
- Consumes: `extractJdSignal(jd, ctx)` (Task 1).
- Produces: free + paid `metadata` include `tokens` + `costUsd`.

- [ ] **Step 1: Update the free orchestrator test**

In `run-free.test.ts`, the `extractJdSignal` dep is currently `async () => signal`. Change it to accept `(jd, ctx)` and mutate ctx (mirroring real cost). Assert the persisted metadata includes `costUsd` + `tokens`:

```typescript
extractJdSignal: async (_jd: string, ctx: { cumulativeCostUsd: number; cumulativeTokens: { input: number } }) => { ctx.cumulativeCostUsd += 0.01; ctx.cumulativeTokens.input += 10; return SIGNAL; },
writer: { invoke: async (_in: unknown, ctx: { cumulativeCostUsd: number }) => { ctx.cumulativeCostUsd += 0.20; return OUT; } },
// …
// after runFreeTier: capture the metadata passed to persistMeta and assert:
expect(captured.costUsd).toBeCloseTo(0.21);
expect(captured.tokens.input).toBe(10);
```

(Adapt to how the existing test captures `persistMeta`'s args — it already asserts call order; extend it to capture the metadata object.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/run-free.test.ts`
Expected: FAIL — metadata has no `costUsd`/`tokens`; `extractJdSignal` not called with ctx.

- [ ] **Step 3: Implement (free path)**

In `run-free.ts`:
- Move the `const ctx: BasePipelineContext = {…}` creation **above** the `extractJdSignal` call, and pass it: `const jdSignal = await deps.extractJdSignal(env.jobDescription, ctx);` (update the `deps.extractJdSignal` type to `(jd: string, ctx: BasePipelineContext) => Promise<JdSignal>`).
- Pass `ctx` to the grounding verifier call too if one exists in run-free (so its cost accrues).
- In `buildFreeMetadata`, add the cost fields. Change its signature to receive `ctx` (or `tokens`+`costUsd`) and include:
```typescript
        tokens:  ctx.cumulativeTokens,
        costUsd: ctx.cumulativeCostUsd,   // LLM-agent cost (extraction + writer [+ grounding]); excludes embeddings/rerank
```
- Update the production wiring in `run-pipeline.ts`'s free fork: the `extractJdSignal` dep stays the function `extractJdSignal` (it now takes the optional ctx; run-free passes its ctx).

- [ ] **Step 4: Implement (paid path)**

In `run-pipeline.ts`:
- Pass the run `ctx` into the JD extraction: change `extractJobDescription(ctx.jobDescription)` (~line 494) to `extractJobDescription(ctx.jobDescription, ctx)`.
- At the final metadata write (~line 874 `updatePipelineRunMetadata(pool, env.pipelineRunId, {…})`), add `tokens: ctx.cumulativeTokens, costUsd: ctx.cumulativeCostUsd` to the object. (Leave the cache-hit write at ~line 451 unchanged — no new cost on a cache hit.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/free/ && yarn tsc --noEmit`
Expected: PASS; 0 type errors. The standard-path tests are unchanged.

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/run-free.ts src/run-pipeline.ts src/free/run-free.test.ts
git add applications/job-strategist/src/free/run-free.ts applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/free/run-free.test.ts
git commit -m "feat(strategist): persist per-run LLM cost+tokens for free and paid

Threads one shared context through JD extraction + writer (+ grounding) and
writes metadata.costUsd/tokens (case-study shape) for both pipelines. Figure is
LLM-agent cost; embeddings/rerank excluded (documented). No behaviour change."
```

---

## Self-Review

**1. Spec coverage:**
- A1 thread ctx through extraction → Task 1 + Task 6. ✓
- A2 persist cost free+paid → Task 6. ✓
- A3 honest gap comment → Task 6 Step 3 (comment). ✓
- B1 commit/PR evidence → Tasks 2 + 4. ✓
- B2 profile-intelligence → Tasks 3 + 4. ✓
- B3 writer envelope → Task 5. ✓
- B4 persona uplift → Task 5. ✓
- B5 eval + grader → Task 5. ✓
- No new LLM calls (loaders are DB; persona/grader are prompt/code) → all tasks. ✓
- Paid unchanged except cost → Task 6. ✓

**2. Placeholder scan:** The "(match the real alias form / existing fixture / how the test captures persistMeta)" notes are verification-against-existing-code instructions, not unwritten logic; each task's new code is complete. No TBD/TODO.

**3. Type consistency:** `loadCommitPrEvidence(pool, userId): Promise<string>`, `loadProfilePositioning(pool, userId): Promise<string>`, `FreeEvidence.commitPrEvidence`/`.profileIntelligence`, `extractJdSignal(jd, ctx?)`, `gradeFreeResume(out, evidence)`, `metadata.costUsd`/`tokens` are consistent across tasks. The cost shape matches the case-study `{ input, output, thinking }` + number.
