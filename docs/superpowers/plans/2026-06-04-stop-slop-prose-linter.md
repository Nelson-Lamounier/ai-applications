# stop-slop Prose Linter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flag-only, non-mutating prose-quality linter to the coach pipeline that scores coach output against the forked stop-slop rule set and logs AI-tell issues without altering persisted output.

**Architecture:** A new `BedrockProseLinter` in `applications/shared/src/prose-quality/` mirrors `BedrockGroundingVerifier`: config → `lint()` → structured result + cost context. It makes one forced-tool Sonnet call per coach run over all prose surfaces tagged with `location`+`register`. `applications/job-strategist/src/run-coach.ts` extracts the sections and calls the linter beside the existing grounding check — fail-open, telemetry only.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), AWS SDK v3 `@aws-sdk/client-bedrock-runtime` (`ConverseCommand`), `prom-client`, Jest, yarn workspaces (`@bedrock/shared` builds to `dist/`).

---

## Key conventions (read once before starting)

- **Module system:** ESM. All relative imports end in `.js` even though source is `.ts`. Every file starts with `/** @format */` (or a fuller header comment, like the grounding files).
- **`@bedrock/shared` is consumed as built output** (`dist/index.js`). After adding exports to `applications/shared/src/index.ts`, the package MUST be rebuilt (`yarn workspace @bedrock/shared build`) before `job-strategist` can import them. This is a real gotcha — Task 7 depends on it.
- **Model id:** repo-wide Sonnet inference profile is `eu.anthropic.claude-sonnet-4-6` (see `applications/self-healing/src/index.ts:67`). Use it as the default, env-overridable via `PROSE_LINTER_MODEL_ID`.
- **Forced tool_use is incompatible with extended thinking** (no thinking budget). Output arrives as a `toolUse` content block, not text.
- **Cost + metrics helpers:** `recordBedrockCost(pool, { userId, modelId, pipeline, inputTokens, outputTokens })` from `../rds/bedrock-cost.js`; `emitEmfMetric(namespace, dims, metrics[])` from `../emf.js`.
- **Lint gate:** run `yarn lint` (root, `eslint .`) before each commit. Project rule: ESLint must pass before any change is complete.
- **Run a single shared test:** `cd applications/shared && npx jest src/prose-quality/<file>.test.ts`. Single job-strategist test: `cd applications/job-strategist && npx jest src/lib/coach-prose.test.ts`.

---

## File structure

**Create (shared):**
- `applications/shared/src/prose-quality/rules/phrases.ts` — forked stop-slop phrase rules (string const)
- `applications/shared/src/prose-quality/rules/structures.ts` — forked stop-slop structure rules (string const)
- `applications/shared/src/prose-quality/rules/rubric.ts` — 5-dimension rubric + `PROSE_PASS_THRESHOLD`
- `applications/shared/src/prose-quality/rules/rules.test.ts` — anchors present, non-empty
- `applications/shared/src/prose-quality/PROVENANCE.md` — upstream + pinned commit + license
- `applications/shared/src/prose-quality/prose-quality-types.ts` — input/output/issue types
- `applications/shared/src/prose-quality/prompt/tool-schema.ts` — `PROSE_QUALITY_TOOL` forced-tool schema
- `applications/shared/src/prose-quality/prompt/system-prompt.ts` — `assembleProseLinterSystemPrompt()`
- `applications/shared/src/prose-quality/prompt/system-prompt.test.ts`
- `applications/shared/src/prose-quality/bedrock-prose-linter.ts` — `BedrockProseLinter`
- `applications/shared/src/prose-quality/bedrock-prose-linter.test.ts`
- `applications/shared/src/prose-quality/index.ts` — barrel
- `applications/shared/src/prose-quality/evals/fixtures/clean.json` — human prose fixtures
- `applications/shared/src/prose-quality/evals/fixtures/slop.json` — seeded-slop fixtures
- `applications/shared/src/prose-quality/evals/run-prose-quality-evals.ts` — Tier-2 live runner (gated)

**Create (job-strategist):**
- `applications/job-strategist/src/lib/coach-prose.ts` — `extractProseSections()`
- `applications/job-strategist/src/lib/coach-prose.test.ts`

**Modify:**
- `applications/shared/src/index.ts` — add prose-quality barrel exports
- `applications/job-strategist/src/run-coach.ts` — add counter + `lintCoachProse()` + call site

---

## Task 1: Forked rule modules + provenance

**Files:**
- Create: `applications/shared/src/prose-quality/rules/phrases.ts`
- Create: `applications/shared/src/prose-quality/rules/structures.ts`
- Create: `applications/shared/src/prose-quality/rules/rubric.ts`
- Create: `applications/shared/src/prose-quality/PROVENANCE.md`
- Test: `applications/shared/src/prose-quality/rules/rules.test.ts`

- [ ] **Step 1: Write the failing test**

`applications/shared/src/prose-quality/rules/rules.test.ts`:
```ts
/** @format */
import { PHRASE_RULES } from './phrases.js';
import { STRUCTURE_RULES } from './structures.js';
import { RUBRIC_RULES, PROSE_PASS_THRESHOLD } from './rubric.js';

describe('prose-quality rule modules', () => {
    it('phrase rules carry the known stop-slop anchors', () => {
        expect(PHRASE_RULES).toContain("It's worth noting");
        expect(PHRASE_RULES).toContain('Throat-Clearing Openers');
        expect(PHRASE_RULES.length).toBeGreaterThan(500);
    });
    it('structure rules carry the known stop-slop anchors', () => {
        expect(STRUCTURE_RULES).toContain('Binary Contrasts');
        expect(STRUCTURE_RULES).toContain('Passive Voice');
        expect(STRUCTURE_RULES.length).toBeGreaterThan(500);
    });
    it('rubric names the five dimensions and a 35 threshold', () => {
        for (const d of ['Directness', 'Rhythm', 'Trust', 'Authenticity', 'Density']) {
            expect(RUBRIC_RULES).toContain(d);
        }
        expect(PROSE_PASS_THRESHOLD).toBe(35);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/prose-quality/rules/rules.test.ts`
Expected: FAIL — cannot find module `./phrases.js`.

- [ ] **Step 3: Create `rules/phrases.ts`**

```ts
/**
 * @format
 * Forked from stop-slop references/phrases.md @ 8da1f03 (MIT). See ../PROVENANCE.md.
 * Loaded verbatim into the linter system prompt as the phrase rule set.
 */
export const PHRASE_RULES = `# Phrases to Remove

## Throat-Clearing Openers

Remove these announcement phrases. State the content directly.

- "Here's the thing:"
- "Here's what [X]"
- "Here's this [X]"
- "Here's that [X]"
- "Here's why [X]"
- "The uncomfortable truth is"
- "It turns out"
- "The real [X] is"
- "Let me be clear"
- "The truth is,"
- "I'll say it again:"
- "I'm going to be honest"
- "Can we talk about"
- "Here's what I find interesting"
- "Here's the problem though"

Any "here's what/this/that" construction is throat-clearing before the point. Cut it and state the point.

## Emphasis Crutches

These add no meaning. Delete them.

- "Full stop." / "Period."
- "Let that sink in."
- "This matters because"
- "Make no mistake"
- "Here's why that matters"

## Business Jargon

Replace with plain language.

| Avoid | Use instead |
|-------|-------------|
| Navigate (challenges) | Handle, address |
| Unpack (analysis) | Explain, examine |
| Lean into | Accept, embrace |
| Landscape (context) | Situation, field |
| Game-changer | Significant, important |
| Double down | Commit, increase |
| Deep dive | Analysis, examination |
| Take a step back | Reconsider |
| Moving forward | Next, from now |
| Circle back | Return to, revisit |
| On the same page | Aligned, agreed |

## Adverbs

Kill all adverbs. No -ly words. No softeners, no intensifiers, no hedges.

Specific offenders:

- "really"
- "just"
- "literally"
- "genuinely"
- "honestly"
- "simply"
- "actually"
- "deeply"
- "truly"
- "fundamentally"
- "inherently"
- "inevitably"
- "interestingly"
- "importantly"
- "crucially"

Also cut these filler phrases:

- "At its core"
- "In today's [X]"
- "It's worth noting"
- "At the end of the day"
- "When it comes to"
- "In a world where"
- "The reality is"

## Meta-Commentary

Remove self-referential asides. The essay should move, not announce its own structure.

- "Hint:"
- "Plot twist:" / "Spoiler:"
- "You already know this, but"
- "But that's another post"
- "X is a feature, not a bug"
- "Dressed up as"
- "The rest of this essay explains..."
- "Let me walk you through..."
- "In this section, we'll..."
- "As we'll see..."
- "I want to explore..."

## Performative Emphasis

False intimacy or manufactured sincerity:

- "creeps in"
- "I promise"
- "They exist, I promise"

## Telling Instead of Showing

Announcing difficulty or significance rather than demonstrating it:

- "This is genuinely hard"
- "This is what leadership actually looks like"
- "This is what X actually looks like"
- "actually matters"

## Vague Declaratives

Sentences that announce importance without naming the specific thing. Kill these.

- "The reasons are structural"
- "The implications are significant"
- "This is the deepest problem"
- "The stakes are high"
- "The consequences are real"

If a sentence says something is important/deep/structural without showing the specific thing, cut it or replace it with the specific thing.`;
```

- [ ] **Step 4: Create `rules/structures.ts`**

```ts
/**
 * @format
 * Forked from stop-slop references/structures.md @ 8da1f03 (MIT). See ../PROVENANCE.md.
 * Loaded verbatim into the linter system prompt as the structure rule set.
 */
export const STRUCTURE_RULES = `# Structures to Avoid

## Binary Contrasts

These create false drama. State the point directly.

| Pattern | Problem |
|---------|---------|
| "Not because X. Because Y." / "Not because X, but because Y." | Telegraphed reversal |
| "[X] isn't the problem. [Y] is." | Formulaic reframe |
| "The answer isn't X. It's Y." | Predictable pivot |
| "It feels like X. It's actually Y." | Setup/reveal cliche |
| "The question isn't X. It's Y." | Rhetorical misdirection |
| "Not X. But Y." / "not X, it's Y" / "isn't X, it's Y" | Mechanical contrast |
| "It's not this. It's that." | Same formula, different words |
| "stops being X and starts being Y" | False transformation arc |
| "doesn't mean X, but actually Y" | Negation-then-assertion crutch |
| "is about X but not Y" | False distinction |
| "not just X but also Y" | Additive hedge |

**Instead:** State Y directly. "The problem is Y." "Y matters here." Drop the negation entirely.

## Negative Listing

Listing what something is *not* before revealing what it *is*. A rhetorical striptease.

| Pattern | Problem |
|---------|---------|
| "Not a X... Not a Y... A Z." | Dramatic buildup through negation |
| "It wasn't X. It wasn't Y. It was Z." | Same structure, past tense |

**Instead:** State Z. The reader doesn't need the runway.

## Dramatic Fragmentation

Sentence fragments for emphasis read as manufactured profundity.

| Pattern | Problem |
|---------|---------|
| "[Noun]. That's it. That's the [thing]." | Performative simplicity |
| "X. And Y. And Z." | Staccato drama |
| "This unlocks something. [Word]." | Artificial revelation |

**Instead:** Complete sentences. Trust content over presentation.

## Rhetorical Setups

These announce insight rather than deliver it.

| Pattern | Problem |
|---------|---------|
| "What if [reframe]?" | Socratic posturing |
| "Here's what I mean:" | Redundant preview |
| "Think about it:" | Condescending prompt |
| "And that's okay." | Unnecessary permission |

**Instead:** Make the point. Let readers draw conclusions.

## Formulaic Constructions

| Pattern | Problem |
|---------|---------|
| "By the time X, I was Y." | Narrative template |
| "X that isn't Y" | Indirect. Say "X is broken" |

## False Agency

Giving inanimate things human verbs. Complaints don't "become" fixes. Bets don't "live or die." Decisions don't "emerge." A person does something to make those things happen. AI loves this because it avoids naming the actor.

| Pattern | Problem |
|---------|---------|
| "a complaint becomes a fix" | The complaint did nothing. Someone fixed it. |
| "a bet lives or dies in days" | Bets don't have lifespans. Someone kills the project or ships it. |
| "the decision emerges" | Decisions don't emerge. Someone decides. |
| "the culture shifts" | Cultures don't shift on their own. People change behavior. |
| "the conversation moves toward" | Conversations don't move. Someone steers. |
| "the data tells us" | Data sits there. Someone reads it and draws a conclusion. |
| "the market rewards" | Markets don't reward. Buyers pay for things. |

**Instead:** Name the human. "The team fixed it that week" beats "the complaint becomes a fix." If no specific person fits, use "you" to put the reader in the seat.

## Narrator-from-a-Distance

Floating above the scene instead of putting the reader in it.

| Pattern | Problem |
|---------|---------|
| "Nobody designed this." | Disembodied observation |
| "This happens because..." | Lecturer voice |
| "This is why..." | Same |
| "People tend to..." | Armchair sociologist |

**Instead:** Put the reader in the room. "You don't sit down one day and decide to..." beats "Nobody designed this."

## Passive Voice

Every sentence needs a subject doing something. Passive voice hides the actor and drains energy.

| Pattern | Fix |
|---------|-----|
| "X was created" | Name who created it |
| "It is believed that" | Name who believes it |
| "Mistakes were made" | Name who made them |
| "The decision was reached" | Name who decided |

**Instead:** Find the actor. Put them at the front of the sentence.

## Sentence Starters to Avoid

| Pattern | Fix |
|---------|-----|
| Sentences starting with What, When, Where, Which, Who, Why, How | Restructure. Lead with the subject or the verb. |
| Paragraphs starting with "So" | Start with content |
| Sentences starting with "Look," | Remove |

Wh- openers become a crutch. "What makes this hard is..." becomes "The constraint is..." or better, name the specific constraint.

## Rhythm Patterns

| Pattern | Fix |
|---------|-----|
| Three-item lists | Use two items or one |
| Questions answered immediately | Let questions breathe or cut them |
| Every paragraph ends punchily | Vary endings |
| Em-dashes | Remove. Use commas or periods. No em dashes at all. |
| Staccato fragmentation | Don't stack short punchy sentences |
| "Not always. Not perfectly." | Hedging disguised as reassurance |

## Word Patterns

| Pattern | Problem |
|---------|---------|
| Lazy extremes (every, always, never, everyone, everybody, nobody) | False authority. Use specifics instead of sweeping claims. |
| All adverbs (-ly words, "really," "just," "literally," "genuinely," "honestly," "simply," "actually") | Empty emphasis. See phrases.md for full list. |`;
```

- [ ] **Step 5: Create `rules/rubric.ts`**

```ts
/**
 * @format
 * Forked from stop-slop SKILL.md scoring rubric @ 8da1f03 (MIT). See ../PROVENANCE.md.
 * The five dimensions and the revise threshold drive the linter's score output.
 */
export const RUBRIC_RULES = `# Scoring Rubric

Score the prose across five dimensions, each 1-10:

| Dimension | Assessment |
|-----------|-----------|
| Directness | Statements or announcements? |
| Rhythm | Varied or metronomic? |
| Trust | Respects reader intelligence? |
| Authenticity | Sounds human? |
| Density | Anything cuttable? |

Sum the five scores for a total out of 50. Below 35/50 means the prose needs revision.`;

/** Total (out of 50) below which prose is flagged for revision. */
export const PROSE_PASS_THRESHOLD = 35;
```

- [ ] **Step 6: Create `PROVENANCE.md`**

```markdown
# Provenance — forked stop-slop rules

- **Upstream:** https://github.com/hardikpandya/stop-slop
- **Pinned commit:** `8da1f030185bdfe8471220585162991eaeb970e9` (2026-03-17)
- **License:** MIT — retain upstream copyright/attribution.
- **Forked files:**
  - `references/phrases.md` → `rules/phrases.ts` (`PHRASE_RULES`)
  - `references/structures.md` → `rules/structures.ts` (`STRUCTURE_RULES`)
  - `SKILL.md` scoring rubric → `rules/rubric.ts` (`RUBRIC_RULES`, `PROSE_PASS_THRESHOLD`)

## Update protocol

1. Bump the pinned commit SHA above and re-fork the changed files.
2. Run the prose-quality eval suite (`bedrock-prose-linter.test.ts` + the gated
   live runner) and reconcile any diffs.
3. This fork is Tucaken's evolving prose style guide — local additions are allowed
   and expected. Record non-upstream additions in a `## Local additions` section here.
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/prose-quality/rules/rules.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/shared/src/prose-quality/rules applications/shared/src/prose-quality/PROVENANCE.md
git commit -m "feat(prose-quality): fork stop-slop rule set + provenance"
```

---

## Task 2: Types

**Files:**
- Create: `applications/shared/src/prose-quality/prose-quality-types.ts`
- Test: covered by Task 3/Task 5 consumers (pure types, no runtime test).

- [ ] **Step 1: Create `prose-quality-types.ts`**

```ts
/**
 * @format
 * Prose-quality linter contract. A flag-only critic that scores prose against the
 * forked stop-slop rules and lists AI-tell issues. Mirrors the grounding contract:
 * config → lint() → structured result + cost context. Never mutates input.
 */

/** Register hint per section — lets the model calibrate (business-formal advice
 *  prose should not be flagged the way resume prose is). */
export type ProseRegister = 'resume-prose' | 'storytelling' | 'advice' | 'narrative';

/** Reserved for a future 'block' mode; only 'flag' is implemented in v1. */
export type ProseLinterMode = 'flag';

export interface ProseSection {
    /** Stable locator, e.g. "jdTalkingPoints[2]" or "behaviouralQuestions[1].answerFramework". */
    readonly location: string;
    readonly register: ProseRegister;
    readonly text: string;
}

export interface ProseQualityInput {
    readonly sections: readonly ProseSection[];
    /** Context hint only (does not change rules). */
    readonly stage?: string;
}

export interface ProseIssue {
    readonly category: 'phrase' | 'structure';
    /** The offending text span. */
    readonly match: string;
    /** Which section it occurred in (mirrors ProseSection.location). */
    readonly location: string;
    readonly severity: 'high' | 'medium' | 'low';
    /** Which rule fired, e.g. "Throat-Clearing Openers" or "Binary Contrasts". */
    readonly rule: string;
}

export interface ProseScore {
    readonly directness: number;   // each 1..10
    readonly rhythm: number;
    readonly trust: number;
    readonly authenticity: number;
    readonly density: number;
    readonly total: number;        // sum, 5..50
}

export interface ProseQualityResult {
    readonly status: 'PASS' | 'FAIL';
    readonly score: ProseScore;
    readonly belowThreshold: boolean;
    readonly issues: readonly ProseIssue[];
}

export interface IProseLinter {
    lint(input: ProseQualityInput): Promise<ProseQualityResult>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd applications/shared && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git add applications/shared/src/prose-quality/prose-quality-types.ts
git commit -m "feat(prose-quality): linter contract types"
```

---

## Task 3: Tool schema + system prompt

**Files:**
- Create: `applications/shared/src/prose-quality/prompt/tool-schema.ts`
- Create: `applications/shared/src/prose-quality/prompt/system-prompt.ts`
- Test: `applications/shared/src/prose-quality/prompt/system-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

`applications/shared/src/prose-quality/prompt/system-prompt.test.ts`:
```ts
/** @format */
import { assembleProseLinterSystemPrompt } from './system-prompt.js';
import { PROSE_QUALITY_TOOL } from './tool-schema.js';

describe('assembleProseLinterSystemPrompt', () => {
    it('returns a cached block then the rules text', () => {
        const blocks = assembleProseLinterSystemPrompt();
        // shape: [{ text }, { cachePoint }] — rules are static, so cache after them.
        const text = blocks.map(b => (b as { text?: string }).text ?? '').join('\n');
        expect(text).toContain('Throat-Clearing Openers');
        expect(text).toContain('Binary Contrasts');
        expect(text).toContain('Directness');
        expect(blocks.some(b => 'cachePoint' in (b as object))).toBe(true);
    });
});

describe('PROSE_QUALITY_TOOL', () => {
    it('requires status, score, belowThreshold, issues', () => {
        const props = PROSE_QUALITY_TOOL.inputSchema.properties;
        expect(Object.keys(props)).toEqual(
            expect.arrayContaining(['status', 'score', 'belowThreshold', 'issues']),
        );
        expect(PROSE_QUALITY_TOOL.inputSchema.required).toEqual(
            expect.arrayContaining(['status', 'score', 'belowThreshold', 'issues']),
        );
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/prose-quality/prompt/system-prompt.test.ts`
Expected: FAIL — cannot find module `./system-prompt.js`.

- [ ] **Step 3: Create `prompt/tool-schema.ts`**

```ts
/**
 * @format
 * Forced-tool schema for the prose linter — the single tight output contract for
 * this phase (one variant, not a shared loose schema). Mirrors ProseQualityResult.
 */
const SCORE_DIMENSION = { type: 'integer', minimum: 1, maximum: 10 } as const;

export const PROSE_QUALITY_TOOL = {
    name: 'emit_prose_quality',
    description: 'Emit the prose-quality verdict: 5-dimension score + AI-tell issues.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['PASS', 'FAIL'] },
            score: {
                type: 'object',
                properties: {
                    directness:   SCORE_DIMENSION,
                    rhythm:       SCORE_DIMENSION,
                    trust:        SCORE_DIMENSION,
                    authenticity: SCORE_DIMENSION,
                    density:      SCORE_DIMENSION,
                    total:        { type: 'integer', minimum: 5, maximum: 50 },
                },
                required: ['directness', 'rhythm', 'trust', 'authenticity', 'density', 'total'],
                additionalProperties: false,
            },
            belowThreshold: { type: 'boolean' },
            issues: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        category: { type: 'string', enum: ['phrase', 'structure'] },
                        match:    { type: 'string' },
                        location: { type: 'string' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                        rule:     { type: 'string' },
                    },
                    required: ['category', 'match', 'location', 'severity', 'rule'],
                    additionalProperties: false,
                },
            },
        },
        required: ['status', 'score', 'belowThreshold', 'issues'],
        additionalProperties: false,
    },
} as const;
```

- [ ] **Step 4: Create `prompt/system-prompt.ts`**

```ts
/**
 * @format
 * Prose-linter system prompt assembly. Single phase, no branches: a stop-slop
 * critic role + the forked rule set + rubric, with a Bedrock cachePoint after the
 * static rules (they never vary per call, so they cache across coach runs).
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';

import { PHRASE_RULES } from '../rules/phrases.js';
import { STRUCTURE_RULES } from '../rules/structures.js';
import { RUBRIC_RULES, PROSE_PASS_THRESHOLD } from '../rules/rubric.js';

const ROLE = `You are a prose-quality critic. You catch the linguistic patterns that mark
text as AI-generated, and you score how human the prose reads.

You receive a document of <section> elements. Each section has a "location"
attribute (echo it verbatim in every issue you raise for that section) and a
"register" attribute that tells you the intended voice:
- resume-prose / storytelling: hold to the rules strictly.
- advice / narrative: business-formal phrasing is acceptable; only flag genuine
  AI-tells, not normal professional language.

Apply the phrase rules and structure rules below. For every violation, emit one
issue: category (phrase|structure), the offending text (match), the section
location, a severity, and the rule name (the nearest "## " heading).

Then score the whole document across the five rubric dimensions (each 1-10), sum
to a total out of 50, set belowThreshold = (total < ${PROSE_PASS_THRESHOLD}), and
set status = belowThreshold ? "FAIL" : "PASS".

Call the emit_prose_quality tool with your verdict. Do not output prose.`;

export function assembleProseLinterSystemPrompt(): SystemContentBlock[] {
    const rules = [ROLE, PHRASE_RULES, STRUCTURE_RULES, RUBRIC_RULES].join('\n\n');
    return [
        { text: rules } as SystemContentBlock,
        { cachePoint: { type: 'default' } } as unknown as SystemContentBlock,
    ];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/prose-quality/prompt/system-prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/shared/src/prose-quality/prompt
git commit -m "feat(prose-quality): forced-tool schema + system prompt assembly"
```

---

## Task 4: BedrockProseLinter

**Files:**
- Create: `applications/shared/src/prose-quality/bedrock-prose-linter.ts`
- Test: `applications/shared/src/prose-quality/bedrock-prose-linter.test.ts`

- [ ] **Step 1: Write the failing test**

`applications/shared/src/prose-quality/bedrock-prose-linter.test.ts`:
```ts
/** @format */
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));
const recordCostMock = jest.fn(async () => {});
jest.mock('../rds/bedrock-cost.js', () => ({ recordBedrockCost: recordCostMock }));

import { BedrockProseLinter } from './bedrock-prose-linter.js';
import type { ProseQualityInput } from './prose-quality-types.js';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

function toolReply(input: unknown, usage?: { inputTokens: number; outputTokens: number }) {
    return {
        output: { message: { content: [{ toolUse: { name: 'emit_prose_quality', input } }] } },
        ...(usage ? { usage } : {}),
    } as unknown as ConverseCommandOutput;
}

const input: ProseQualityInput = {
    sections: [{ location: 'coachingNotes', register: 'advice', text: "It's worth noting you did well." }],
    stage: 'phone_screen',
};

const goodVerdict = {
    status: 'FAIL',
    score: { directness: 5, rhythm: 6, trust: 6, authenticity: 5, density: 6, total: 28 },
    belowThreshold: true,
    issues: [{ category: 'phrase', match: "It's worth noting", location: 'coachingNotes', severity: 'high', rule: 'Adverbs' }],
};

describe('BedrockProseLinter', () => {
    beforeEach(() => { sendMock.mockReset(); emitMock.mockReset(); recordCostMock.mockClear(); });

    it('parses a tool verdict into ProseQualityResult', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('FAIL');
        expect(r.belowThreshold).toBe(true);
        expect(r.score.total).toBe(28);
        expect(r.issues[0].location).toBe('coachingNotes');
    });

    it('records Bedrock cost as prose-lint when a costCtx is supplied', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict, { inputTokens: 800, outputTokens: 40 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = {} as any;
        await new BedrockProseLinter({ mode: 'flag' }).lint(input, { pool, userId: 'u-1' });
        expect(recordCostMock).toHaveBeenCalledWith(pool, expect.objectContaining({
            userId: 'u-1', pipeline: 'prose-lint', inputTokens: 800, outputTokens: 40,
        }));
    });

    it('fails OPEN on unparseable output — PASS, no issues, warns', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockResolvedValueOnce(toolReply(undefined));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('PASS');
        expect(r.belowThreshold).toBe(false);
        expect(r.issues).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('fails OPEN when the model schema is malformed (missing score)', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockResolvedValueOnce(toolReply({ status: 'FAIL', issues: [] }));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('PASS');
        warn.mockRestore();
    });

    it('returns PASS without calling Bedrock when there are no sections', async () => {
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint({ sections: [] });
        expect(r.status).toBe('PASS');
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('emits ProseChecked=1 and ProseFailed=1 on FAIL', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict));
        await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        const metrics = emitMock.mock.calls.at(-1)?.[2];
        expect(metrics).toEqual([
            { name: 'ProseChecked', value: 1, unit: 'Count' },
            { name: 'ProseFailed', value: 1, unit: 'Count' },
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/shared && npx jest src/prose-quality/bedrock-prose-linter.test.ts`
Expected: FAIL — cannot find module `./bedrock-prose-linter.js`.

- [ ] **Step 3: Create `bedrock-prose-linter.ts`**

```ts
/**
 * @format
 * BedrockProseLinter — flag-only prose-quality critic via Converse forced-tool.
 *
 * Mirrors BedrockGroundingVerifier's slot (config → lint() → structured result +
 * cost ctx) but inverts the failure default: any parse/schema/transport error
 * fails OPEN (status PASS, no issues) so a broken style check never degrades a
 * working coach run. Never mutates input.
 */
import {
    BedrockRuntimeClient,
    ConverseCommand,
    type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType as __DocumentType } from '@smithy/types';
import type { Pool } from 'pg';

import { emitEmfMetric } from '../emf.js';
import { recordBedrockCost } from '../rds/bedrock-cost.js';
import { assembleProseLinterSystemPrompt } from './prompt/system-prompt.js';
import { PROSE_QUALITY_TOOL } from './prompt/tool-schema.js';
import type {
    IProseLinter,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseSection,
} from './prose-quality-types.js';

const METRIC_NAMESPACE = 'BedrockSharedSafety';

/** Per-call context for booking the linter's Sonnet spend. Optional. */
export interface ProseLinterCostContext {
    pool:   Pool;
    userId: string;
}

export interface BedrockProseLinterConfig {
    readonly mode: ProseLinterMode;       // only 'flag' in v1
    readonly modelId?: string;
    readonly client?: BedrockRuntimeClient;
}

/** A fail-open PASS result, used whenever the model output cannot be trusted. */
const PASS_OPEN: ProseQualityResult = {
    status: 'PASS',
    score: { directness: 0, rhythm: 0, trust: 0, authenticity: 0, density: 0, total: 0 },
    belowThreshold: false,
    issues: [],
};

function renderUserMessage(sections: readonly ProseSection[]): string {
    return sections
        .map(s => `<section location="${s.location}" register="${s.register}">\n${s.text}\n</section>`)
        .join('\n');
}

function extractToolInput(response: ConverseCommandOutput): unknown {
    const blocks = response.output?.message?.content ?? [];
    const toolUse = blocks
        .map(b => (b as { toolUse?: { input?: unknown } }).toolUse)
        .find(t => t && t.input !== undefined);
    return toolUse?.input;
}

/** Validate the model payload into a ProseQualityResult, or null if malformed. */
function coerce(raw: unknown): ProseQualityResult | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const s = o['score'] as Record<string, unknown> | undefined;
    const dims = ['directness', 'rhythm', 'trust', 'authenticity', 'density', 'total'] as const;
    if (!s || dims.some(d => typeof s[d] !== 'number')) return null;
    if (o['status'] !== 'PASS' && o['status'] !== 'FAIL') return null;
    if (typeof o['belowThreshold'] !== 'boolean') return null;
    if (!Array.isArray(o['issues'])) return null;
    return {
        status: o['status'] as 'PASS' | 'FAIL',
        score: {
            directness:   s['directness'] as number,
            rhythm:       s['rhythm'] as number,
            trust:        s['trust'] as number,
            authenticity: s['authenticity'] as number,
            density:      s['density'] as number,
            total:        s['total'] as number,
        },
        belowThreshold: o['belowThreshold'] as boolean,
        issues: o['issues'] as ProseQualityResult['issues'],
    };
}

export class BedrockProseLinter implements IProseLinter {
    private readonly mode: ProseLinterMode;
    private readonly modelId: string;
    private readonly client: BedrockRuntimeClient;

    constructor(config: BedrockProseLinterConfig) {
        this.mode = config.mode;
        this.modelId =
            config.modelId ?? process.env.PROSE_LINTER_MODEL_ID ?? 'eu.anthropic.claude-sonnet-4-6';
        this.client = config.client ?? new BedrockRuntimeClient({});
    }

    async lint(input: ProseQualityInput, costCtx?: ProseLinterCostContext): Promise<ProseQualityResult> {
        if (input.sections.length === 0) return PASS_OPEN;

        let response: ConverseCommandOutput;
        try {
            const command = new ConverseCommand({
                modelId: this.modelId,
                system: assembleProseLinterSystemPrompt(),
                messages: [{ role: 'user', content: [{ text: renderUserMessage(input.sections) }] }],
                inferenceConfig: { maxTokens: 4096 },
                toolConfig: {
                    tools: [{
                        toolSpec: {
                            name: PROSE_QUALITY_TOOL.name,
                            description: PROSE_QUALITY_TOOL.description,
                            inputSchema: { json: PROSE_QUALITY_TOOL.inputSchema as unknown as __DocumentType },
                        },
                    }],
                    toolChoice: { tool: { name: PROSE_QUALITY_TOOL.name } },
                },
            });
            response = await this.client.send(command);
        } catch (err) {
            console.warn('[prose-linter] Bedrock call failed — failing open (PASS):', (err as Error).message);
            return PASS_OPEN;
        }

        if (costCtx?.userId) {
            recordBedrockCost(costCtx.pool, {
                userId:       costCtx.userId,
                modelId:      this.modelId,
                pipeline:     'prose-lint',
                inputTokens:  response.usage?.inputTokens  ?? 0,
                outputTokens: response.usage?.outputTokens ?? 0,
            }).catch(e => console.warn('[prose-linter] cost record failed (non-fatal)', e));
        }

        const result = coerce(extractToolInput(response));
        if (!result) {
            console.warn('[prose-linter] unparseable model output — failing open (PASS).');
            emitEmfMetric(METRIC_NAMESPACE, { Module: 'prose-quality', Mode: this.mode }, [
                { name: 'ProseChecked', value: 1, unit: 'Count' },
                { name: 'ProseFailed', value: 0, unit: 'Count' },
            ]);
            return PASS_OPEN;
        }

        emitEmfMetric(METRIC_NAMESPACE, { Module: 'prose-quality', Mode: this.mode }, [
            { name: 'ProseChecked', value: 1, unit: 'Count' },
            { name: 'ProseFailed', value: result.status === 'FAIL' ? 1 : 0, unit: 'Count' },
        ]);
        return result;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/shared && npx jest src/prose-quality/bedrock-prose-linter.test.ts`
Expected: PASS (6 tests).

> Note: the malformed-schema test expects fail-open even though the real Bedrock
> forced-tool decoder normally guarantees schema compliance. `coerce()` is the
> defensive net for that guarantee breaking.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/shared/src/prose-quality/bedrock-prose-linter.ts applications/shared/src/prose-quality/bedrock-prose-linter.test.ts
git commit -m "feat(prose-quality): BedrockProseLinter with fail-open contract"
```

---

## Task 5: Barrel + shared export + build

**Files:**
- Create: `applications/shared/src/prose-quality/index.ts`
- Modify: `applications/shared/src/index.ts`

- [ ] **Step 1: Create `prose-quality/index.ts`**

```ts
/**
 * @format
 * Prose-quality — Public API. A flag-only prose critic that scores LLM prose
 * output against the forked stop-slop rules and lists AI-tell issues. Runs in the
 * same pipeline slot as the grounding verifier; never mutates persisted output.
 */
export { BedrockProseLinter } from './bedrock-prose-linter.js';
export type {
    BedrockProseLinterConfig,
    ProseLinterCostContext,
} from './bedrock-prose-linter.js';
export { PROSE_PASS_THRESHOLD } from './rules/rubric.js';
export type {
    IProseLinter,
    ProseIssue,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseRegister,
    ProseScore,
    ProseSection,
} from './prose-quality-types.js';
```

- [ ] **Step 2: Add exports to `applications/shared/src/index.ts`**

Find the grounding export block (search for `BedrockGroundingVerifier`) and add directly beneath it:
```ts
export {
    BedrockProseLinter,
    PROSE_PASS_THRESHOLD,
} from './prose-quality/index.js';
export type {
    BedrockProseLinterConfig,
    ProseLinterCostContext,
    IProseLinter,
    ProseIssue,
    ProseLinterMode,
    ProseQualityInput,
    ProseQualityResult,
    ProseRegister,
    ProseScore,
    ProseSection,
} from './prose-quality/index.js';
```

- [ ] **Step 3: Typecheck, build, full shared test**

```bash
cd applications/shared
npx tsc --noEmit
npx jest src/prose-quality
yarn build           # REQUIRED — refreshes dist/ so job-strategist resolves the new exports
```
Expected: typecheck clean, all prose-quality tests PASS, build emits `dist/`.

- [ ] **Step 4: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/shared/src/prose-quality/index.ts applications/shared/src/index.ts
git commit -m "feat(prose-quality): export linter from @bedrock/shared"
```

---

## Task 6: Coach prose extractor

**Files:**
- Create: `applications/job-strategist/src/lib/coach-prose.ts`
- Test: `applications/job-strategist/src/lib/coach-prose.test.ts`

This mirrors `extractCoachClaims` in `coach-grounding.ts` but emits tagged
`ProseSection[]` (location + register) instead of a concatenated string. Cover the
same experiential surfaces; skip gap skill-transfer entries (they assert absence).

- [ ] **Step 1: Write the failing test**

`applications/job-strategist/src/lib/coach-prose.test.ts`:
```ts
/** @format */
import { extractProseSections } from './coach-prose.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const coaching = {
    stage: 'phone_screen',
    stageDescription: 'Recruiter screen.',
    coachingNotes: 'Be concise.',
    careerArcSummary: 'Backend to platform.',
    jdTalkingPoints: [{ point: 'Led migration.', evidence: 'proj-1' }],
    technicalQuestions: [{ question: 'Q', answerFramework: 'STAR on the migration.', sourceProject: 'proj-1' }],
    behaviouralQuestions: [{ question: 'Q2', answerFramework: 'Conflict story.', sourceProject: 'proj-2' }],
    skillTransfer: [
        { jdSkill: 'k8s', tier: 'direct', narrative: 'Ran the cluster.' },
        { jdSkill: 'rust', tier: 'gap', narrative: 'No evidence.' },
    ],
} as unknown as InterviewCoachResult;

describe('extractProseSections', () => {
    const sections = extractProseSections(coaching);
    const at = (loc: string) => sections.find(s => s.location === loc);

    it('tags stageDescription as narrative', () => {
        expect(at('stageDescription')?.register).toBe('narrative');
    });
    it('tags coachingNotes as advice', () => {
        expect(at('coachingNotes')?.register).toBe('advice');
    });
    it('tags jdTalkingPoints[0].point as resume-prose', () => {
        expect(at('jdTalkingPoints[0].point')?.text).toBe('Led migration.');
        expect(at('jdTalkingPoints[0].point')?.register).toBe('resume-prose');
    });
    it('tags answer frameworks as storytelling', () => {
        expect(at('technicalQuestions[0].answerFramework')?.register).toBe('storytelling');
        expect(at('behaviouralQuestions[0].answerFramework')?.register).toBe('storytelling');
    });
    it('includes non-gap skillTransfer narrative, excludes gap entries', () => {
        expect(at('skillTransfer[0].narrative')?.text).toBe('Ran the cluster.');
        expect(sections.some(s => s.text === 'No evidence.')).toBe(false);
    });
    it('skips empty/missing fields', () => {
        const empty = extractProseSections({ stage: 'technical' } as unknown as InterviewCoachResult);
        expect(empty).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && npx jest src/lib/coach-prose.test.ts`
Expected: FAIL — cannot find module `./coach-prose.js`.

- [ ] **Step 3: Create `coach-prose.ts`**

```ts
/**
 * @format
 * Coach prose extractor — turns InterviewCoachResult into tagged ProseSection[]
 * for BedrockProseLinter. Sibling to coach-grounding.ts's extractCoachClaims: same
 * experiential surfaces, but each becomes a located, register-tagged section so the
 * linter can attribute issues and calibrate by voice. Gap skill-transfer entries
 * are excluded (they assert absence of evidence, not a prose claim).
 */
import type { InterviewCoachResult, ProseSection, ProseRegister } from '@bedrock/shared';

function push(out: ProseSection[], location: string, register: ProseRegister, v: unknown): void {
    if (typeof v === 'string' && v.trim().length > 0) {
        out.push({ location, register, text: v.trim() });
    }
}

export function extractProseSections(coaching: InterviewCoachResult): ProseSection[] {
    const c = coaching as unknown as Record<string, unknown>;
    const out: ProseSection[] = [];

    push(out, 'stageDescription', 'narrative', c['stageDescription']);
    push(out, 'careerArcSummary', 'narrative', c['careerArcSummary']);
    push(out, 'coachingNotes', 'advice', c['coachingNotes']);

    const tps = (c['jdTalkingPoints'] as Array<Record<string, unknown>> | undefined) ?? [];
    tps.forEach((tp, i) => push(out, `jdTalkingPoints[${i}].point`, 'resume-prose', tp['point']));

    for (const key of ['technicalQuestions', 'behaviouralQuestions'] as const) {
        const qs = (c[key] as Array<Record<string, unknown>> | undefined) ?? [];
        qs.forEach((q, i) => push(out, `${key}[${i}].answerFramework`, 'storytelling', q['answerFramework']));
    }

    const st = (c['skillTransfer'] as Array<Record<string, unknown>> | undefined) ?? [];
    st.forEach((e, i) => {
        if (e['tier'] === 'gap') return;
        push(out, `skillTransfer[${i}].narrative`, 'resume-prose', e['narrative']);
    });

    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && npx jest src/lib/coach-prose.test.ts`
Expected: PASS (6 tests).

> If `ProseSection`/`ProseRegister` fail to import from `@bedrock/shared`, the shared
> `dist/` was not rebuilt — re-run `yarn workspace @bedrock/shared build` (Task 5 Step 3).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/job-strategist/src/lib/coach-prose.ts applications/job-strategist/src/lib/coach-prose.test.ts
git commit -m "feat(prose-quality): coach prose section extractor"
```

---

## Task 7: Wire the linter into run-coach

**Files:**
- Modify: `applications/job-strategist/src/run-coach.ts`

Add a prom counter, a `lintCoachProse()` helper modeled exactly on the existing
`verifyCoachGrounding()` (try/catch, fail-open, prom + log), and call it beside the
grounding check. No code path may throw into the coach run.

- [ ] **Step 1: Add imports**

In the `@bedrock/shared` import block (the one that already imports
`BedrockGroundingVerifier`), add `BedrockProseLinter`:
```ts
    BedrockGroundingVerifier,
    BedrockProseLinter,
```
In the `./lib/coach-grounding.js` import line region, add a new import below it:
```ts
import { extractProseSections } from './lib/coach-prose.js';
```

- [ ] **Step 2: Add the counter + linter instance**

Directly below the `coachGrounding` Counter definition (ends around line 82), add:
```ts
// Coach prose-quality verdicts (stop-slop). status ∈ PASS|FAIL|error|skipped.
const coachProse = new Counter({
    name:       'job_strategist_coach_prose_total',
    help:       'Coach output prose-quality verdicts by stage and status.',
    labelNames: ['stage', 'status'] as const,
    registers:  [obs.registry],
});

// Prose linting runs in 'flag' mode only: telemetry on AI-tell language, never
// alters persisted coach output, never throws into the pipeline.
const coachProseLinter = new BedrockProseLinter({ mode: 'flag' });
```

- [ ] **Step 3: Add the `lintCoachProse` helper**

Directly below the `verifyCoachGrounding` function (ends around line 130), add:
```ts
/**
 * Lint the coach's prose surfaces for AI-tell language and record the verdict
 * (metric + log). Flag-mode + fail-open: pure observability — never alters
 * persisted output and never throws into the pipeline.
 */
async function lintCoachProse(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    coaching: InterviewCoachResult,
): Promise<void> {
    try {
        const sections = extractProseSections(coaching);
        if (sections.length === 0) {
            coachProse.inc({ stage: env.interviewStage, status: 'skipped' });
            return;
        }
        const q = await coachProseLinter.lint(
            { sections, stage: env.interviewStage },
            { pool, userId: env.userId },
        );
        coachProse.inc({ stage: env.interviewStage, status: q.status });
        if (q.status === 'FAIL') {
            log.warn({
                coachPipelineRunId: env.coachPipelineRunId,
                applicationId:      env.applicationId,
                stage:              env.interviewStage,
                proseScore:         q.score,
                proseIssues:        q.issues,
            }, 'coach_prose_below_threshold');
        }
    } catch (e) {
        coachProse.inc({ stage: env.interviewStage, status: 'error' });
        log.warn({
            coachPipelineRunId: env.coachPipelineRunId,
            stage:              env.interviewStage,
            err:                (e as Error).message,
        }, 'coach_prose_lint_failed (non-fatal)');
    }
}
```

`InterviewCoachResult` is already imported in run-coach.ts via the type import block
(it is used by `executeCoachAgent`'s return). If tsc reports it missing, add
`InterviewCoachResult` to the `import type { … } from '@bedrock/shared'` block.

- [ ] **Step 4: Call it beside the grounding check**

In `main()`, immediately after the existing `await verifyCoachGrounding(...)` call
(ends around line 242) and before `await persistCoachingContent(...)`, add:
```ts
        // Prose-quality lint on coach output — flag-mode, runs for EVERY stage.
        // Fail-open: never fails the run, never alters what is persisted.
        await lintCoachProse(pool, env, coaching.data);
```

- [ ] **Step 5: Typecheck + full job-strategist test suite**

```bash
cd applications/job-strategist
npx tsc --noEmit
npx jest
```
Expected: typecheck clean; existing suite + `coach-prose.test.ts` all PASS.

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/job-strategist/src/run-coach.ts
git commit -m "feat(prose-quality): wire prose linter into coach pipeline (flag mode)"
```

---

## Task 8: Evals — fixtures + gated live runner

**Files:**
- Create: `applications/shared/src/prose-quality/evals/fixtures/clean.json`
- Create: `applications/shared/src/prose-quality/evals/fixtures/slop.json`
- Create: `applications/shared/src/prose-quality/evals/run-prose-quality-evals.ts`

Per CLAUDE.md rule 5. The deterministic linter behavior (parse, fail-open, schema,
metrics) is already covered by `bedrock-prose-linter.test.ts` (Task 4) — those ARE
the per-phase deterministic evals. This task adds the Tier-2 **live** eval (real
Sonnet call) plus the fixtures it grades, gated behind `RUN_LIVE_EVALS=1` so default
`jest`/CI never call Bedrock (mirrors `job-strategist/src/evals/live/`).

- [ ] **Step 1: Create `evals/fixtures/clean.json`**

Human-sounding prose that should score at/above threshold with no high-severity issues.
```json
{
  "sections": [
    { "location": "jdTalkingPoints[0].point", "register": "resume-prose",
      "text": "I cut the deploy pipeline from 40 minutes to 9 by caching the Docker layer build and parallelising the test shards." },
    { "location": "behaviouralQuestions[0].answerFramework", "register": "storytelling",
      "text": "We disagreed about the rollback plan. I pulled the on-call data, showed two prior incidents where the manual path failed, and we agreed to automate it. The next incident recovered in four minutes." },
    { "location": "coachingNotes", "register": "advice",
      "text": "Bring the migration metrics to the screen. Recruiters at this company ask for concrete before/after numbers." }
  ],
  "stage": "phone_screen",
  "expect": { "minTotal": 35, "noHighSeverity": true }
}
```

- [ ] **Step 2: Create `evals/fixtures/slop.json`**

Prose seeded with named stop-slop patterns; the linter must catch them and FAIL.
```json
{
  "sections": [
    { "location": "jdTalkingPoints[0].point", "register": "resume-prose",
      "text": "It's worth noting that I'm genuinely passionate about engineering. At the end of the day, this is what leadership actually looks like." },
    { "location": "behaviouralQuestions[0].answerFramework", "register": "storytelling",
      "text": "The problem wasn't the code. It was the culture. Mistakes were made. But that's another story." },
    { "location": "coachingNotes", "register": "advice",
      "text": "Let me be clear: you need to lean into the deep dive and circle back on the landscape. Full stop." }
  ],
  "stage": "phone_screen",
  "expect": {
    "status": "FAIL",
    "mustMatch": ["It's worth noting", "Mistakes were made", "Let me be clear"]
  }
}
```

- [ ] **Step 3: Create `evals/run-prose-quality-evals.ts`**

```ts
/** @format */
/**
 * Tier-2 live eval for the prose linter. Gated behind RUN_LIVE_EVALS=1 so default
 * jest/CI never call Bedrock. Run before any prompt/rule change:
 *   RUN_LIVE_EVALS=1 npx tsx src/prose-quality/evals/run-prose-quality-evals.ts
 *
 * Asserts: clean fixture scores >= minTotal with no high-severity issues; slop
 * fixture returns FAIL and catches each `mustMatch` phrase (by issue.match).
 */
import clean from './fixtures/clean.json' assert { type: 'json' };
import slop from './fixtures/slop.json' assert { type: 'json' };
import { BedrockProseLinter } from '../bedrock-prose-linter.js';
import type { ProseQualityInput } from '../prose-quality-types.js';

const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

async function main(): Promise<void> {
    if (!LIVE_ENABLED) {
        console.log('RUN_LIVE_EVALS not set — skipping prose-quality live evals.');
        return;
    }
    const linter = new BedrockProseLinter({ mode: 'flag' });
    const failures: string[] = [];

    const cleanRes = await linter.lint({ sections: clean.sections, stage: clean.stage } as ProseQualityInput);
    if (cleanRes.score.total < clean.expect.minTotal) {
        failures.push(`clean: total ${cleanRes.score.total} < ${clean.expect.minTotal}`);
    }
    if (clean.expect.noHighSeverity && cleanRes.issues.some(i => i.severity === 'high')) {
        failures.push(`clean: unexpected high-severity issue(s): ${JSON.stringify(cleanRes.issues)}`);
    }

    const slopRes = await linter.lint({ sections: slop.sections, stage: slop.stage } as ProseQualityInput);
    if (slopRes.status !== 'FAIL') failures.push(`slop: expected FAIL, got ${slopRes.status}`);
    for (const phrase of slop.expect.mustMatch) {
        if (!slopRes.issues.some(i => i.match.includes(phrase))) {
            failures.push(`slop: did not catch "${phrase}"`);
        }
    }

    if (failures.length) {
        console.error('PROSE EVAL FAILURES:\n' + failures.join('\n'));
        process.exitCode = 1;
    } else {
        console.log('Prose-quality live evals PASSED (clean + slop).');
    }
}

void main();
```

- [ ] **Step 4: Verify the gated runner no-ops without the flag**

Run: `cd applications/shared && npx tsx src/prose-quality/evals/run-prose-quality-evals.ts`
Expected: prints `RUN_LIVE_EVALS not set — skipping prose-quality live evals.`, exit 0.
(Do NOT run the live `RUN_LIVE_EVALS=1` path here — it bills Bedrock. The implementer
runs it manually once to confirm clean PASS / slop FAIL before considering Task 8 done.)

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd applications/shared && npx tsc --noEmit
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn lint
git add applications/shared/src/prose-quality/evals
git commit -m "test(prose-quality): clean/slop fixtures + gated live eval runner"
```

- [ ] **Step 6: Run the live eval once (manual gate)**

```bash
cd applications/shared
RUN_LIVE_EVALS=1 npx tsx src/prose-quality/evals/run-prose-quality-evals.ts
```
Expected: `Prose-quality live evals PASSED (clean + slop).` If it fails, tune the
system prompt wording in `prompt/system-prompt.ts` (not the rules) and re-run. Do not
ship a rule/prompt change without this passing (rule 5).

---

## Final verification

- [ ] `cd applications/shared && npx tsc --noEmit && npx jest src/prose-quality` — all green
- [ ] `cd applications/shared && yarn build` — dist refreshed
- [ ] `cd applications/job-strategist && npx tsc --noEmit && npx jest` — all green
- [ ] `yarn lint` (root) — clean
- [ ] Live eval ran once and PASSED (Task 8 Step 6)
- [ ] No coach output mutation: confirm `persistCoachingContent` still receives
      `coaching.data` unchanged (the linter call sits between grounding and persist,
      returns nothing into the persist path)

---

## Self-Review (completed by plan author)

**Spec coverage:** placement (Task 5), interface (Task 2), Sonnet forced-tool +
cachePoint + fail-open (Tasks 3–4), extraction + run-coach hook (Tasks 6–7), evals
clean/slop/schema/register (Task 4 deterministic + Task 8 live). All spec sections map
to tasks.

**Deviation from spec §7:** the spec said "add a prose grader to the coach `GRADERS`
array." That array runs deterministic, model-free graders over coach gold fixtures;
the linter needs a live Sonnet call, so folding it in would put a Bedrock call inside
the default jest run. Resolved by splitting evals: deterministic linter behavior lives
in `bedrock-prose-linter.test.ts` (Task 4); the live clean/slop eval is gated behind
`RUN_LIVE_EVALS=1` (Task 8), mirroring the existing `evals/live/` pattern. Same rule-5
intent, correct test isolation.

**Type consistency:** `ProseSection`/`ProseRegister`/`ProseQualityResult` names are
consistent across types (Task 2), schema (Task 3), linter (Task 4), barrel (Task 5),
extractor (Task 6), wiring (Task 7), evals (Task 8). `extractProseSections` and
`lintCoachProse` names are stable across Tasks 6–7.

**Build ordering:** Task 5 Step 3 rebuilds `@bedrock/shared` before Task 6 consumes
the new exports — the documented dist gotcha.
