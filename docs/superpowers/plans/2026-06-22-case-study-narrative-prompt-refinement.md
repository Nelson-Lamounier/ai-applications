# Case-Study Narrative Prompt Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the case-study system prompt so output reads as one combined product story led by the work the commits/PRs show was built (and by whom), with verified tech demoted to a grounding aid and a confident voice — shipped with a per-phase eval.

**Architecture:** Three components in one PR. (1) Edit `SYSTEM_PROMPT_TEXT` in `case-study-agent.ts` for four narrative directives — no schema change. (2) Surface authorship (`author_login`) for commits and pulls through the loader and envelope — no migration, columns exist and are populated. (3) A new deterministic-grader module plus one injectable LLM-judge, wired into the E2E script, mirroring the existing `case-study-product-grader` / `change-impact-narrator.eval` patterns.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Jest (`@jest/globals`), Bedrock via `runAgent` (Sonnet 4.6), Postgres (`pg` Pool).

## Global Constraints

- **Language/copy:** English (UK) in all prose/comments; `-ise`/`-our`/`-re`; no non-ASCII diacritics. Term for the job doc is `resume`.
- **ESLint:** Run ESLint before any task is considered complete. `applications/` complexity ceiling is 10 (keep grader functions flat — use table-driven dispatch like the existing stubs).
- **No migration in this PR.** `repo_commits.author_login` and `repo_pull_requests.author_login` already exist (migration `045_repo_commits_pulls.sql`) and are populated by `RdsRepoActivityStore`. Do not add a migration.
- **`author_login` is nullable.** Treat absent authorship as "unknown"; never fabricate. Graders must not require it.
- **Prompt change ships with its eval** (CLAUDE.md §5). The existing product/refine grader suites are the regression guard and must stay green.
- **Default model Sonnet** for the judge (`eu.anthropic.claude-sonnet-4-6` / `CASE_STUDY_MODEL`); no Haiku.
- **Branch:** `spec/case-study-narrative-prompt-refinement` (already off `develop`). Do not commit to `develop`/`main`.
- **Commit identity:** do NOT add "Co-Authored-By: Claude". Commit bodies/PR description as impact bullets.

---

## File Structure

- **Modify** `applications/shared/src/projects/case-study-agent.ts` — `SYSTEM_PROMPT_TEXT` (lines 63–131): append four narrative directives.
- **Modify** `applications/shared/src/projects/case-study-types.ts` — add `authorLogin?: string | null` to the `commits` and `pulls` shapes of `CaseStudyContext` (lines 232–255).
- **Modify** `applications/shared/src/projects/case-study-loader.ts` — add `author_login` to the commit + pull SELECTs and map to `authorLogin` (lines 405–437).
- **Modify** `applications/shared/src/projects/case-study-product-grader.ts` — `export` the reusable `TECH_TOKENS`, `words`, `significant`, `firstParagraph` so the narrative grader reuses them (DRY).
- **Create** `applications/shared/src/projects/case-study-narrative-grader.ts` — three deterministic graders + `runNarrativeGraders` + the injectable `judgeCombinedOverview`.
- **Create** `applications/shared/src/projects/case-study-narrative-grader.eval.test.ts` — good fixture passes all; one bad fixture per grader; judge driven by a mock `invoke`.
- **Create** `applications/shared/src/projects/case-study-narrative-prompt.test.ts` — regression guard asserting the four directives are present in `SYSTEM_PROMPT_TEXT`.
- **Modify** `applications/shared/src/projects/case-study-loader.test.ts` — assert `authorLogin` is selected + mapped for commits and pulls.
- **Modify** `scripts/test-projects-case-study.ts` — run `runNarrativeGraders` on the live output; include the real Bedrock judge when `CASE_STUDY_EVAL_JUDGE=1`.

---

## Task 1: Prompt edits — four narrative directives

**Files:**
- Modify: `applications/shared/src/projects/case-study-agent.ts:63-131`
- Test: `applications/shared/src/projects/case-study-narrative-prompt.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: an unchanged `buildSystemPrompt(context)` signature; `SYSTEM_PROMPT_TEXT` now contains the directive phrases the regression test and graders assume (`combined`, `do not narrate repo-by-repo`, `spine`, `grounding aid`, `state it plainly`).

- [ ] **Step 1: Write the failing regression test**

Create `applications/shared/src/projects/case-study-narrative-prompt.test.ts`:

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt } from './case-study-agent.js';
import type { CaseStudyContext } from './case-study-types.js';

// Minimal context — only fields buildSystemPrompt reads (archetype/priorCaseStudy absent).
const baseContext = {} as unknown as CaseStudyContext;

describe('case-study system prompt — narrative directives', () => {
    const prompt = buildSystemPrompt(baseContext);

    it('D1: instructs one combined story, not per-repo fragments', () => {
        expect(prompt).toMatch(/ONE coherent project story/i);
        expect(prompt).toMatch(/do not narrate repo-by-repo/i);
    });

    it('D2: makes the work + collaboration the narrative spine', () => {
        expect(prompt).toMatch(/the work and the collaboration are the spine/i);
        expect(prompt).toMatch(/who built it/i);
    });

    it('D3: keeps the verifiedStack constraint but demotes tech to a grounding aid', () => {
        expect(prompt).toMatch(/MUST be drawn from/i);     // constraint preserved
        expect(prompt).toMatch(/grounding aid/i);           // demotion present
        expect(prompt).toMatch(/NOT the thing the narrative is organised around/i);
    });

    it('D4: asks for a confident, un-hedged voice', () => {
        expect(prompt).toMatch(/state it (directly|plainly)/i);
        expect(prompt).toMatch(/avoid hedged/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-prompt.test.ts`
Expected: FAIL — the directive phrases are not yet in `SYSTEM_PROMPT_TEXT`.

- [ ] **Step 3: Edit `SYSTEM_PROMPT_TEXT`**

In `case-study-agent.ts`, insert the **combined-overview** block immediately after the product-lead paragraph (after the line ending `...no matter how impressive the\ninternals.` at line 73), before `Rules:`:

```
Synthesise ONE coherent project story across all repositories and
components. Do NOT narrate repo-by-repo. The pitch opens with what the
combined product is and does as a whole; a member repo's role is
mentioned only in service of that one story.
```

Augment **Rule 1** by appending this sentence to its end (after `...not just the commit message.`):

```
     Lead the engineering sections (decisions, challenges, highlights)
     with what the commits and pull requests show was built, and who
     built it (commit + PR \`authorLogin\`) — the work and the
     collaboration are the spine. Each engineering row narrates real
     work the commits/PRs demonstrate; cite that same evidence in
     \`sourceSignals\`.
```

Append the **tech-assists** demotion to the end of the `verifiedStack` paragraph (after `...attached deterministically after generation.` at line 131):

```
 verifiedStack is the tech the work USED — a grounding aid for the
\`stack\` section, NOT the thing the narrative is organised around. Never
structure the pitch, decisions, or highlights around the tech list;
organise them around the work and its outcomes, then let the verified
tech ground the stack.
```

Append the **confident-voice** block as a final paragraph of `SYSTEM_PROMPT_TEXT`:

```
Narrate real, evidenced work plainly and confidently. The author did
this work — state it directly. Avoid hedged phrasing ("claimed",
"attempted to", "appears to") and never use "we built". If a row is
grounded enough to include, it is grounded enough to state plainly.
```

(Keep the existing backtick-escaping style — `SYSTEM_PROMPT_TEXT` is a template literal, so escape any literal backticks as `\``.)

- [ ] **Step 4: Run the new test + the existing prompt/grader suites**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-prompt.test.ts src/projects/case-study-product-grader.test.ts src/projects/case-study-refine-grader.test.ts src/projects/case-study-agent.test.ts`
Expected: PASS — directives present, product/refine framing unbroken.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/shared && yarn eslint src/projects/case-study-agent.ts src/projects/case-study-narrative-prompt.test.ts
git add applications/shared/src/projects/case-study-agent.ts applications/shared/src/projects/case-study-narrative-prompt.test.ts
git commit -m "feat(projects): case-study prompt leads with combined work-led narrative

Rewrite the case-study system prompt around four narrative directives:
one combined project story across all repos (not per-repo fragments);
the commits/PRs and their authors as the engineering spine; verified
tech demoted from narrative lead to a grounding aid (constraint kept);
and a confident, un-hedged voice. Guarded by a prompt-contains
regression test; product/refine grader suites stay green."
```

---

## Task 2: Loader authorship — surface `author_login`

**Files:**
- Modify: `applications/shared/src/projects/case-study-types.ts:232-255`
- Modify: `applications/shared/src/projects/case-study-loader.ts:405-437`
- Test: `applications/shared/src/projects/case-study-loader.test.ts`

**Interfaces:**
- Consumes: existing `repo_commits` / `repo_pull_requests` rows.
- Produces: `CaseStudyContext.commits[].authorLogin?: string | null` and `CaseStudyContext.pulls[].authorLogin?: string | null`, serialised into the `<project>` envelope unchanged via `buildUserMessage`.

- [ ] **Step 1: Add the optional type fields**

In `case-study-types.ts`, add to the `commits` item shape (after `readonly authorName: string;`):

```typescript
        readonly authorLogin?: string | null;
```

and to the `pulls` item shape (after `readonly htmlUrl: string;`):

```typescript
        readonly authorLogin?: string | null;
```

- [ ] **Step 2: Write the failing loader test**

In `case-study-loader.test.ts`, add a test (the `makePool` stub and `loadCaseStudyContext` are already imported). Supply canned `commits`/`pulls` rows that include `author_login`, and assert the mapped context carries `authorLogin`:

```typescript
describe('loadCaseStudyContext — authorship', () => {
    it('maps author_login onto commits and pulls (null-safe)', async () => {
        const pool = makePool({
            projects:     [projectRow],
            repositories: [{ repo_full_name: 'me/app', /* …minimal repo row… */ }],
            commits: [
                { repo_full_name: 'me/app', sha: 'abc1234', author_name: 'Nelson', author_login: 'nelson', authored_at: '2026-01-01T00:00:00Z', message: 'init' },
                { repo_full_name: 'me/app', sha: 'def5678', author_name: 'Bot',    author_login: null,     authored_at: '2026-01-02T00:00:00Z', message: 'ci' },
            ],
            pulls: [
                { repo_full_name: 'me/app', number: 1, title: 'PR', body: null, state: 'merged', author_login: 'nelson', merged_at: '2026-01-03T00:00:00Z', html_url: 'https://x/1' },
            ],
        });
        const ctx = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(ctx.commits[0].authorLogin).toBe('nelson');
        expect(ctx.commits[1].authorLogin).toBeNull();
        expect(ctx.pulls[0].authorLogin).toBe('nelson');
    });
});
```

(Match the existing `projectRow`/repo-row fixtures already defined in the test file; fill the minimal repo row from the file's existing example.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/shared && yarn jest src/projects/case-study-loader.test.ts -t authorship`
Expected: FAIL — `authorLogin` is `undefined` (SELECT + map not yet updated).

- [ ] **Step 4: Update the SELECTs + maps**

In `case-study-loader.ts`, change the commit query + row type + map:

```typescript
    const commitRows = (await pool.query<{ repo_full_name: string; sha: string; author_name: string; author_login: string | null; authored_at: Date | string; message: string }>(
        `SELECT repo_full_name, sha, author_name, author_login, authored_at, message
           FROM repo_commits
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
          ORDER BY authored_at DESC`,
        [p.user_id, repoNames],
    )).rows;
    const commits = commitRows.map((r) => ({
        repoFullName: r.repo_full_name,
        sha:          r.sha,
        authoredAt:   r.authored_at instanceof Date ? r.authored_at.toISOString() : String(r.authored_at),
        authorName:   r.author_name,
        authorLogin:  r.author_login,
        message:      r.message,
    }));
```

and the pull query + row type + map:

```typescript
    const pullRows = (await pool.query<{ repo_full_name: string; number: number; title: string; body: string | null; state: string; author_login: string | null; merged_at: Date | string | null; html_url: string }>(
        `SELECT repo_full_name, number, title, body, state, author_login, merged_at, html_url
           FROM repo_pull_requests
          WHERE user_id = $1 AND repo_full_name = ANY($2::text[])
          ORDER BY merged_at DESC NULLS LAST`,
        [p.user_id, repoNames],
    )).rows;
    const pulls = pullRows.map((r) => ({
        repoFullName: r.repo_full_name,
        number:       r.number,
        title:        r.title,
        body:         r.body,
        state:        r.state as 'open' | 'closed' | 'merged',
        authorLogin:  r.author_login,
        mergedAt:     r.merged_at ? (r.merged_at instanceof Date ? r.merged_at.toISOString() : String(r.merged_at)) : null,
        htmlUrl:      r.html_url,
    }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/shared && yarn jest src/projects/case-study-loader.test.ts`
Expected: PASS (existing loader tests + the new authorship test).

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/shared && yarn eslint src/projects/case-study-loader.ts src/projects/case-study-types.ts src/projects/case-study-loader.test.ts
git add applications/shared/src/projects/case-study-loader.ts applications/shared/src/projects/case-study-types.ts applications/shared/src/projects/case-study-loader.test.ts
git commit -m "feat(projects): surface commit + PR author_login to the case-study agent

Carry author_login from repo_commits and repo_pull_requests through the
loader into the case-study envelope so the prompt's 'who built it'
narrative has real authorship for both commits and PRs. Columns already
exist (migration 045) and are populated by ingestion — SELECT + map
only, no migration, null-safe for deleted/unknown accounts."
```

---

## Task 3: Deterministic narrative graders + eval

**Files:**
- Modify: `applications/shared/src/projects/case-study-product-grader.ts` (export shared helpers)
- Create: `applications/shared/src/projects/case-study-narrative-grader.ts`
- Test: `applications/shared/src/projects/case-study-narrative-grader.eval.test.ts`

**Interfaces:**
- Consumes: `TECH_TOKENS`, `words`, `significant`, `firstParagraph` from `case-study-product-grader.ts`; `CaseStudy` from `case-study-types.ts`.
- Produces:
  - `interface NarrativeGradeInput { readonly caseStudy: CaseStudy }`
  - `interface NarrativeGradeResult { readonly grader: string; readonly pass: boolean; readonly score: number; readonly failures: readonly string[] }`
  - `gradeWorkLeadsNarrative(i): NarrativeGradeResult`
  - `gradeTechNotSpine(i): NarrativeGradeResult`
  - `gradeConfidentVoice(i): NarrativeGradeResult`
  - `runNarrativeGraders(i): { pass: boolean; results: readonly NarrativeGradeResult[] }`

- [ ] **Step 1: Export the reusable helpers from product-grader**

In `case-study-product-grader.ts`, add `export` to the four helpers so the narrative grader reuses them (no duplication):

```typescript
export const TECH_TOKENS: ReadonlySet<string> = new Set([ /* …unchanged… */ ]);
// …
export const words = (s: string): string[] =>
    s.toLowerCase().match(/[a-z0-9+]+/g) ?? [];
export const significant = (s: string): string[] =>
    words(s).filter((w) => w.length > 3 && !STOPWORDS.has(w) && !TECH_TOKENS.has(w));
export function firstParagraph(pitch: string): string { /* …unchanged… */ }
```

- [ ] **Step 2: Write the failing eval test**

Create `applications/shared/src/projects/case-study-narrative-grader.eval.test.ts`:

```typescript
/**
 * @format
 * Narrative-phase eval (CLAUDE.md §5). Defines "good output" for the refined
 * case-study prompt: one combined story, work+collaboration as the spine,
 * tech demoted to a grounding aid, confident voice. Deterministic graders run
 * in CI (no Bedrock); the combined-overview judge is driven here by a mock.
 */
import { describe, it, expect } from '@jest/globals';
import {
    gradeWorkLeadsNarrative,
    gradeTechNotSpine,
    gradeConfidentVoice,
    runNarrativeGraders,
} from './case-study-narrative-grader.js';
import type { CaseStudy } from './case-study-types.js';

const sig = (over: Partial<CaseStudy['highlights'][number]['sourceSignals']> = {}) => ({
    commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' as const, ...over,
});
const commitSig = sig({ commits: [{ repoFullName: 'me/app', sha: 'abc1234', authoredAt: 'x', message: 'm' }] });

// A "good" case study: work-led rows, product-led pitch, confident voice.
const GOOD: CaseStudy = {
    tagline: 'A coaching tool that prepares engineers for interviews',
    pitch: 'I built a coaching tool that helps engineers rehearse interviews.\n\nI designed the grounding pipeline so every claim ties to a commit.',
    stack: [],
    decisions:  [{ title: 'Chose RDS', context: 'c', decision: 'd', consequences: 'q', confidence: 'high', sourceSignals: commitSig }],
    highlights: [{ title: 'Shipped the coach', description: 'I built the coaching flow end to end.', sourceSignals: commitSig }],
    challenges: [{ problem: 'Grounding was hard', solution: 'I added a verifier.', sourceSignals: commitSig }],
    depthMarkers: { hasTests: true, testCoverageSignal: 'some', hasCi: true, ciMaturity: 'basic', documentationDensity: 'some', hasDeploymentEvidence: false, deploymentUrl: null, refactorCount: 0 },
    architecture: { diagramFormat: 'mermaid', diagramSource: 'graph LR', nodes: [], edges: [] },
    resumeBullets: [{ angle: 'backend', bullets: ['Built X'] }],
};

describe('case-study narrative eval — good fixture', () => {
    it('passes every deterministic grader', () => {
        expect(runNarrativeGraders({ caseStudy: GOOD }).pass).toBe(true);
    });
});

describe('case-study narrative eval — one bad fixture per grader', () => {
    it('gradeWorkLeadsNarrative fails when a highlight cites no commit or pull', () => {
        const bad = { ...GOOD, highlights: [{ ...GOOD.highlights[0], sourceSignals: sig({ files: [{ repoFullName: 'me/app', path: 'a.ts' }] }) }] };
        expect(gradeWorkLeadsNarrative({ caseStudy: bad }).pass).toBe(false);
    });

    it('gradeTechNotSpine fails when a highlight title is tech-dominated', () => {
        const bad = { ...GOOD, highlights: [{ ...GOOD.highlights[0], title: 'Kubernetes EKS Terraform Helm ArgoCD pipeline' }] };
        expect(gradeTechNotSpine({ caseStudy: bad }).pass).toBe(false);
    });

    it('gradeConfidentVoice fails on hedged phrasing', () => {
        const bad = { ...GOOD, pitch: 'We built a tool that appears to help engineers.' };
        expect(gradeConfidentVoice({ caseStudy: bad }).pass).toBe(false);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-grader.eval.test.ts`
Expected: FAIL — `case-study-narrative-grader.js` does not exist.

- [ ] **Step 4: Implement the grader module**

Create `applications/shared/src/projects/case-study-narrative-grader.ts`:

```typescript
/**
 * @format
 * Deterministic graders for the case-study NARRATIVE contract (CLAUDE.md §5).
 *
 * String/array checks only — no LLM call — so they run in CI on every prompt
 * change AND can grade a live agent run. They encode the refined prompt's
 * promises: the engineering rows are led by the work the commits/PRs show
 * (workLeadsNarrative); tech is a grounding aid, never the spine
 * (techNotSpine); and the voice is confident, not hedged (confidentVoice).
 *
 * The subjective "reads as one combined story" dimension is graded separately
 * by `judgeCombinedOverview` (an injectable LLM judge), kept out of the
 * deterministic CI path.
 */
import { TECH_TOKENS, words, firstParagraph } from './case-study-product-grader.js';
import type { CaseStudy, SourceSignal } from './case-study-types.js';

export interface NarrativeGradeInput {
    readonly caseStudy: CaseStudy;
}
export interface NarrativeGradeResult {
    readonly grader: string;
    readonly pass: boolean;
    readonly score: number; // 0..1
    readonly failures: readonly string[];
}
export interface NarrativeGradeReport {
    readonly pass: boolean;
    readonly results: readonly NarrativeGradeResult[];
}

const mk = (grader: string, failures: string[], score?: number): NarrativeGradeResult => ({
    grader,
    pass: failures.length === 0,
    score: score ?? (failures.length === 0 ? 1 : 0),
    failures,
});

const hasWork = (sig: SourceSignal): boolean => sig.commits.length > 0 || sig.pulls.length > 0;

/** Every engineering row (highlight/challenge/decision) is led by commit/PR work. */
export function gradeWorkLeadsNarrative(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    cs.highlights.forEach((h, i) => { if (!hasWork(h.sourceSignals)) failures.push(`highlight[${i}] "${h.title}" cites no commit or PR`); });
    cs.challenges.forEach((c, i) => { if (!hasWork(c.sourceSignals)) failures.push(`challenge[${i}] "${c.problem.slice(0, 40)}" cites no commit or PR`); });
    cs.decisions.forEach((d, i) => { if (!hasWork(d.sourceSignals)) failures.push(`decision[${i}] "${d.title}" cites no commit or PR`); });
    return mk('workLeadsNarrative', failures);
}

/** Tech must not be the organising spine: pitch + highlight titles aren't tech-dominated. */
function techDominated(text: string): boolean {
    const ws = words(text).filter((w) => w.length > 2);
    if (ws.length === 0) return false;
    const tech = ws.filter((w) => TECH_TOKENS.has(w)).length;
    return tech / ws.length > 0.5;
}
export function gradeTechNotSpine(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    if (techDominated(firstParagraph(cs.pitch))) failures.push('pitch first paragraph is tech-dominated — organise it around the work, not the stack');
    cs.highlights.forEach((h, i) => { if (techDominated(h.title)) failures.push(`highlight[${i}] title is tech-dominated — lead with the work, not the tech`); });
    return mk('techNotSpine', failures);
}

/** Confident voice: no hedge tokens in pitch / highlight descriptions / decision text. */
const HEDGES: ReadonlyArray<RegExp> = [
    /\bclaimed\b/i, /\bappears to\b/i, /\battempted to\b/i, /\bwe built\b/i, /\bwe designed\b/i,
];
function hedgesIn(text: string): string[] {
    return HEDGES.filter((re) => re.test(text)).map((re) => re.source);
}
export function gradeConfidentVoice(input: NarrativeGradeInput): NarrativeGradeResult {
    const cs = input.caseStudy;
    const failures: string[] = [];
    const corpus = [cs.pitch, ...cs.highlights.map((h) => h.description), ...cs.decisions.map((d) => `${d.context} ${d.decision} ${d.consequences}`)];
    corpus.forEach((t) => { for (const h of hedgesIn(t)) failures.push(`hedged phrasing "${h}" — state evidenced work plainly`); });
    return mk('confidentVoice', failures);
}

const NARRATIVE_GRADERS: ReadonlyArray<(i: NarrativeGradeInput) => NarrativeGradeResult> = [
    gradeWorkLeadsNarrative,
    gradeTechNotSpine,
    gradeConfidentVoice,
];

export function runNarrativeGraders(input: NarrativeGradeInput): NarrativeGradeReport {
    const results = NARRATIVE_GRADERS.map((g) => g(input));
    return { pass: results.every((r) => r.pass), results };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-grader.eval.test.ts src/projects/case-study-product-grader.test.ts`
Expected: PASS (new eval green; product-grader suite still green after the `export` change).

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/shared && yarn eslint src/projects/case-study-narrative-grader.ts src/projects/case-study-narrative-grader.eval.test.ts src/projects/case-study-product-grader.ts
git add applications/shared/src/projects/case-study-narrative-grader.ts applications/shared/src/projects/case-study-narrative-grader.eval.test.ts applications/shared/src/projects/case-study-product-grader.ts
git commit -m "feat(projects): deterministic narrative graders for the case-study prompt

Add workLeadsNarrative (every highlight/challenge/decision cites a
commit or PR), techNotSpine (pitch + highlight titles not tech-
dominated), and confidentVoice (no hedge tokens) — reusing the product-
grader tech-token heuristic. Ship the eval: a good fixture passes all,
one bad fixture per grader fails exactly that grader."
```

---

## Task 4: LLM-judge for combined overview + E2E wiring

**Files:**
- Modify: `applications/shared/src/projects/case-study-narrative-grader.ts` (add the injectable judge)
- Modify: `applications/shared/src/projects/case-study-narrative-grader.eval.test.ts` (mock-judge test)
- Modify: `scripts/test-projects-case-study.ts` (run graders + real judge behind the env flag)

**Interfaces:**
- Consumes: `runAgent` / `AgentConfig` (`applications/shared/src/agent-runner.ts`, `types.ts`); `CASE_STUDY_MODEL` env.
- Produces:
  - `interface CombinedOverviewJudge { invoke(args: { pitch: string }): Promise<{ score: number; reasoning: string }> }`
  - `judgeCombinedOverview(caseStudy: CaseStudy, judge: CombinedOverviewJudge, threshold?: number): Promise<NarrativeGradeResult>` (default `threshold = 0.7`)
  - `bedrockCombinedOverviewJudge: CombinedOverviewJudge` (real Sonnet judge)

- [ ] **Step 1: Add the failing mock-judge test**

Append to `case-study-narrative-grader.eval.test.ts`:

```typescript
import { judgeCombinedOverview } from './case-study-narrative-grader.js';

describe('case-study narrative eval — combined-overview judge (mocked)', () => {
    it('passes when the judge scores at/above threshold', async () => {
        const judge = { invoke: async () => ({ score: 0.9, reasoning: 'one combined story' }) };
        const res = await judgeCombinedOverview(GOOD, judge, 0.7);
        expect(res.pass).toBe(true);
        expect(res.score).toBe(0.9);
    });

    it('fails when the judge scores below threshold (reads as fragments)', async () => {
        const judge = { invoke: async () => ({ score: 0.4, reasoning: 'per-repo fragments' }) };
        const res = await judgeCombinedOverview(GOOD, judge, 0.7);
        expect(res.pass).toBe(false);
        expect(res.failures[0]).toMatch(/fragment/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-grader.eval.test.ts -t judge`
Expected: FAIL — `judgeCombinedOverview` not exported.

- [ ] **Step 3: Implement the injectable judge + the Bedrock judge**

Append to `case-study-narrative-grader.ts`:

```typescript
import { runAgent } from '../agent-runner.js';
import type { AgentConfig } from '../types.js';

export interface CombinedOverviewJudge {
    invoke(args: { pitch: string }): Promise<{ score: number; reasoning: string }>;
}

/** Grade the subjective "one combined story, not per-repo fragments" dimension. */
export async function judgeCombinedOverview(
    caseStudy: CaseStudy,
    judge: CombinedOverviewJudge,
    threshold = 0.7,
): Promise<NarrativeGradeResult> {
    const { score, reasoning } = await judge.invoke({ pitch: caseStudy.pitch });
    const failures = score >= threshold ? [] : [`pitch reads as per-repo fragments (judge ${score.toFixed(2)} < ${threshold}): ${reasoning}`];
    return { grader: 'combinedOverview', pass: failures.length === 0, score, failures };
}

const JUDGE_MODEL = process.env.CASE_STUDY_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const JUDGE_TOOL = {
    name: 'emit_overview_score',
    description: 'Score whether the pitch reads as one combined product story.',
    inputSchema: {
        type: 'object',
        properties: {
            score:     { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['score', 'reasoning'],
        additionalProperties: false,
    },
};
const JUDGE_PROMPT =
    'You grade portfolio case-study pitches. Score 0..1 how well the pitch reads as ONE coherent ' +
    'product story across all repositories, versus a list of per-repo fragments. 1 = one combined ' +
    'overview leading with what the product is and does; 0 = disjoint per-repo description. Emit ' +
    'the emit_overview_score tool.';

export const bedrockCombinedOverviewJudge: CombinedOverviewJudge = {
    async invoke({ pitch }) {
        const config: AgentConfig = {
            agentName:      'case-study-overview-judge',
            modelId:        process.env.INFERENCE_PROFILE_ARN ?? JUDGE_MODEL,
            maxTokens:      512,
            thinkingBudget: 0,
            systemPrompt:   [{ text: JUDGE_PROMPT }],
            pipeline:       'case-study-overview-judge',
            promptId:       'case-study-overview-judge-v1',
            tool:           JUDGE_TOOL,
        };
        const res = await runAgent<{ score: number; reasoning: string }>({
            config,
            userMessage: `<pitch>\n${pitch}\n</pitch>\n\nEmit the emit_overview_score tool now.`,
            pipelineContext: { dryRun: false } as never,
            parseResponse: (text) => JSON.parse(text) as { score: number; reasoning: string },
        });
        return res.output;
    },
};
```

(Confirm the `runAgent` `parseResponse`/`pipelineContext`/`AgentResult.output` shape against `agent-runner.ts:314` and mirror `bedrockCaseStudyAgent` exactly — adjust the `parseResponse` and the `pipelineContext` literal to match the real `BasePipelineContext` the script already constructs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/shared && yarn jest src/projects/case-study-narrative-grader.eval.test.ts`
Expected: PASS (deterministic graders + mocked judge).

- [ ] **Step 5: Wire into the E2E script**

In `scripts/test-projects-case-study.ts`, after the case study is generated/asserted, add a grader report (mirror the existing `console.log` step style):

```typescript
import { runNarrativeGraders, judgeCombinedOverview, bedrockCombinedOverviewJudge } from '../applications/shared/src/projects/case-study-narrative-grader.js';

// …after the orchestrator produces `caseStudy`…
console.log('Running narrative graders...');
const narrative = runNarrativeGraders({ caseStudy });
for (const r of narrative.results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.grader}${r.failures.length ? ` — ${r.failures.join('; ')}` : ''}`);
if (process.env.CASE_STUDY_EVAL_JUDGE === '1') {
    const judged = await judgeCombinedOverview(caseStudy, bedrockCombinedOverviewJudge);
    console.log(`  ${judged.pass ? 'PASS' : 'FAIL'} ${judged.grader} (score ${judged.score.toFixed(2)})${judged.failures.length ? ` — ${judged.failures.join('; ')}` : ''}`);
}
if (!narrative.pass) throw new Error('narrative graders failed');
```

(Bind `caseStudy` to whatever variable the script already holds the persisted/generated output in — check the orchestrator call around line 733.)

- [ ] **Step 6: Run the full project test suite + ESLint**

Run: `cd applications/shared && yarn jest src/projects/ && yarn eslint src/projects/case-study-narrative-grader.ts`
Expected: PASS — whole `projects/` suite green.

(The live E2E `scripts/test-projects-case-study.ts` needs `PGHOST`/`PGUSER` + Bedrock creds; run it manually when validating against a real DB, with `CASE_STUDY_EVAL_JUDGE=1` to include the judge.)

- [ ] **Step 7: Commit**

```bash
git add applications/shared/src/projects/case-study-narrative-grader.ts applications/shared/src/projects/case-study-narrative-grader.eval.test.ts scripts/test-projects-case-study.ts
git commit -m "feat(projects): combined-overview LLM judge + wire narrative eval into E2E

Add an injectable Sonnet judge scoring whether the pitch reads as one
combined product story versus per-repo fragments (mocked in CI, real
Bedrock behind CASE_STUDY_EVAL_JUDGE=1). Wire runNarrativeGraders into
the case-study E2E so a live run reports work-led/tech-demoted/confident
deterministically and fails the run on a regression."
```

---

## Self-Review

**1. Spec coverage:**
- D1 combined overview → Task 1 (prompt) + Task 4 judge. ✓
- D2 work+collaboration lead → Task 1 (prompt) + Task 2 (authorship data) + Task 3 `gradeWorkLeadsNarrative`. ✓
- D3 tech assists → Task 1 (prompt, constraint kept + demotion) + Task 3 `gradeTechNotSpine`. ✓
- D4 confident voice → Task 1 (prompt) + Task 3 `gradeConfidentVoice`. ✓
- Loader authorship, no migration → Task 2. ✓
- Eval = 3 deterministic + 1 judge → Tasks 3–4. ✓
- Out-of-scope (reviewer ingestion, merged_by, display) → not implemented, correct. ✓

**2. Placeholder scan:** Two explicit "confirm against the real signature" notes (judge `runAgent` shape in Task 4 Step 3; `caseStudy` variable binding in Task 4 Step 5) — these are verification instructions, not unwritten code; the surrounding code is complete and mirrors `bedrockCaseStudyAgent`. No TBD/TODO.

**3. Type consistency:** `NarrativeGradeResult`/`NarrativeGradeInput` consistent across Tasks 3–4; `authorLogin` field name consistent across types, loader, prompt (Task 1 references `authorLogin`), and tests; grader names (`workLeadsNarrative`, `techNotSpine`, `confidentVoice`, `combinedOverview`) consistent between implementation and tests.
