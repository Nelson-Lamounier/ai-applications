# ATS keyword-coverage v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the brittle literal-phrase ATS keyword match with atomic-source + 3-tier matching (normalized → ontology synonym → embedding), so coverage reflects true honest match for any JD/user.

**Architecture:** Atomic must-haves from the JD-extractor; a `matchTerm` function with 3 tiers (deterministic normalize/token, ontology family-vocab, conservative embedding); threaded into the ATS check + pipeline.

**Tech Stack:** TypeScript (NodeNext ESM, `.js`), Zod, Jest (ts-jest CJS), `TitanEmbeddingProvider`.

**Spec:** `docs/superpowers/specs/2026-06-11-ats-keyword-v2-design.md`. Branch `feat/ats-keyword-v2` (off develop). Build shared: `cd applications/shared && npx tsc --build`.

---

## Task 1: atomic source + normalized/token match (Tier 1)

**Files:** Modify `applications/job-strategist/src/ats/jd-keywords.ts`; create `applications/job-strategist/src/ats/keyword-match.ts` + `keyword-match.test.ts`.

- [ ] **Step 0:** confirm the JD-extraction type. `grep -n "JdExtraction\|requiredSkills\|concepts\|tools" applications/job-strategist/src/agents/jd-extractor.ts` — it exports `JdExtractionSchema`/`JdExtraction` with `requiredSkills: string[]`, `tools: string[]`, `concepts: string[]`. Confirm the exact type name + how it's imported.

- [ ] **Step 1: Failing tests** — create `keyword-match.test.ts`:
```ts
/** @format */
import { normalizeTerm, matchTier1 } from './keyword-match.js';

describe('normalizeTerm', () => {
    it('lowercases, strips qualifiers, collapses punctuation', () => {
        expect(normalizeTerm('Expert-level SaaS troubleshooting skills')).toBe('saas troubleshooting');
        expect(normalizeTerm('Critical thinking and root cause analysis')).toBe('critical thinking and root cause analysis');
        expect(normalizeTerm('Python scripting')).toBe('python scripting');
        expect(normalizeTerm('Support ticketing systems (implied)')).toBe('support ticketing systems');
    });
});

describe('matchTier1', () => {
    const resume = 'support engineer with python and bash automation; root-cause analysis across aws iam; runbook authoring'.toLowerCase();
    it('normalized substring match (hyphen/space agnostic)', () => {
        expect(matchTier1('root cause analysis', resume)).toBe(true);   // resume has "root-cause analysis"
    });
    it('token-subset match (all content tokens present)', () => {
        expect(matchTier1('Python scripting', resume)).toBe(true);      // "python" present (scripting stripped? no — token subset: python + scripting; scripting absent)
    });
    it('returns false when a content token is absent', () => {
        expect(matchTier1('ChatGPT integration', resume)).toBe(false);
    });
    it('atomic present term matches', () => {
        expect(matchTier1('AWS', resume)).toBe(true);
    });
});
```
NOTE on the "Python scripting" case: decide the token-subset rule. SPEC INTENT: "Python scripting" should match because the candidate has Python. Use this rule: **match if the normalized term is a substring OR if ≥1 *distinctive* content token (length ≥ 4, not a generic word like "system/tools/skills") is present AND no *distinctive* token is contradicted.** Simpler + deterministic: **match if normalized-substring OR all tokens with length ≥ 4 are present.** For "Python scripting" → tokens ≥4 = [python, scripting]; "scripting" absent → would be FALSE under all-tokens. To make "Python scripting"→true, treat "scripting"/"systems"/"tools"/"management" as generic-suffix tokens stripped in `normalizeTerm` (add them to the qualifier set). Then "Python scripting"→"python"→present. ADD `scripting, systems, system, tools, tooling, management, collaboration, communication` to the qualifier stopwords so multi-word skills reduce to their distinctive core. Re-confirm the `normalizeTerm` test expectations match (e.g. `'Python scripting'`→`'python'`). UPDATE the test to the rule you implement; the PRINCIPLE: distinctive core tokens must be present.

- [ ] **Step 2: Implement** `keyword-match.ts`:
```ts
/** @format */

const QUALIFIERS = new Set([
    'expert', 'expertlevel', 'expert-level', 'strong', 'advanced', 'solid', 'proven', 'excellent',
    'skills', 'skill', 'capabilities', 'capability', 'experience', 'experienced', 'knowledge',
    'proficiency', 'proficient', 'ability', 'hands', 'on', 'handson', 'similar', 'etc', 'implied',
    'eg', 'ie', 'and', 'or', 'the', 'a', 'an', 'of', 'in', 'with', 'for', 'to',
    // generic skill-suffix tokens — strip so multi-word skills reduce to their distinctive core
    'scripting', 'systems', 'system', 'tools', 'tooling', 'management', 'collaboration', 'communication', 'capabilities',
]);

/** Lowercase, strip qualifier tokens, collapse non-alphanumerics, trim. */
export function normalizeTerm(t: string): string {
    const tokens = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
    return tokens.filter((tok) => tok.length > 0 && !QUALIFIERS.has(tok)).join(' ');
}

function normalizeResume(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

/**
 * Tier 1 — deterministic normalized/token match.
 * true if the normalized term is a substring of the normalized resume, OR every
 * remaining content token of the term is present as a word in the resume.
 */
export function matchTier1(term: string, resumeLowerText: string): boolean {
    const normTerm = normalizeTerm(term);
    if (normTerm.length === 0) return false;
    const resume = normalizeResume(resumeLowerText);
    if (resume.includes(normTerm)) return true;
    const tokens = normTerm.split(' ').filter((t) => t.length >= 3);
    if (tokens.length === 0) return false;
    return tokens.every((tok) => new RegExp(`(^| )${tok}( |$)`).test(resume));
}
```
(Adjust the QUALIFIERS + the `normalizeTerm` test expectations so the suite passes with your final rule. Keep the test honest: a genuinely-absent skill like "ChatGPT" must return false.)

- [ ] **Step 3: atomic source** in `jd-keywords.ts` — add an overload that prefers jdExtraction:
```ts
import type { JdExtraction } from '../agents/jd-extractor.js'; // confirm the export

/** v2 atomic must-haves: prefer the JD-extractor's atomic terms; fallback to research. Cap 18. */
export function collectJdMustHavesV2(jd: JdExtraction | null, r: StrategistResearchResult): string[] {
    const out = new Set<string>();
    const add = (arr: string[]) => { for (const t of arr) { const s = t.trim(); if (s) out.add(s); } };
    if (jd && (jd.requiredSkills.length + jd.tools.length + jd.concepts.length) > 0) {
        add(jd.requiredSkills); add(jd.tools); add(jd.concepts);
    } else {
        add(collectJdMustHaves(r)); // v1 fallback (kept)
    }
    return [...out].slice(0, 18);
}
```
Keep the existing `collectJdMustHaves` (used by the fallback + existing tests).

- [ ] **Step 4:** `cd applications/job-strategist && yarn test keyword-match jd-keywords` → pass; `npx tsc --noEmit` clean. Commit:
```bash
git add applications/job-strategist/src/ats/keyword-match.ts applications/job-strategist/src/ats/keyword-match.test.ts applications/job-strategist/src/ats/jd-keywords.ts
git commit -m "feat(ats): atomic JD keyword source + normalized/token match (tier 1)"
```

---

## Task 2: ontology + embedding tiers (full matchTerm)

**Files:** Modify `keyword-match.ts` + `.test.ts`.

- [ ] **Step 1: Failing tests** (append):
```ts
import { matchTerm } from './keyword-match.js';

const resume = 'support engineer; escalation management and sla ownership; python automation; aws iam'.toLowerCase();
const familyVocab = [['escalation', 'sla', 'on-call', 'incident response', 'root cause analysis']];

describe('matchTerm (3 tiers)', () => {
    it('tier1 normalized match', async () => {
        const r = await matchTerm('python', resume, { familyVocab, embedder: null, threshold: 0.55 });
        expect(r.present).toBe(true); expect(r.tier).toBe('normalized');
    });
    it('tier2 ontology synonym — JD term in family vocab + resume has a family vocab term', async () => {
        // "incident response" not literally in resume, but "escalation"/"sla" are, same family group
        const r = await matchTerm('incident response', resume, { familyVocab, embedder: null, threshold: 0.55 });
        expect(r.present).toBe(true); expect(r.tier).toBe('ontology');
    });
    it('tier3 embedding — conservative semantic match when literal+ontology miss', async () => {
        const embedder = { embed: jest.fn()
            .mockResolvedValueOnce([1, 0, 0])   // resume vector
            .mockResolvedValueOnce([0.9, 0.1, 0]) }; // term vector (cosine ~0.99)
        const r = await matchTerm('customer support tickets', resume, { familyVocab: [], embedder, threshold: 0.55 });
        expect(r.present).toBe(true); expect(r.tier).toBe('embedding');
    });
    it('none — genuine gap, no tier credits it', async () => {
        const embedder = { embed: jest.fn().mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 0]) }; // cosine 0
        const r = await matchTerm('ChatGPT', resume, { familyVocab: [], embedder, threshold: 0.55 });
        expect(r.present).toBe(false); expect(r.tier).toBe('none');
    });
    it('embedder error → fail-open, no false credit', async () => {
        const embedder = { embed: jest.fn().mockRejectedValue(new Error('down')) };
        const r = await matchTerm('ChatGPT', resume, { familyVocab: [], embedder, threshold: 0.55 });
        expect(r.present).toBe(false); expect(r.tier).toBe('none');
    });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** in `keyword-match.ts`:
```ts
export type MatchTier = 'literal' | 'normalized' | 'ontology' | 'embedding' | 'none';
export interface Embedder { embed(text: string): Promise<number[]>; }
export interface MatchCtx { familyVocab: string[][]; embedder: Embedder | null; threshold: number; resumeVector?: number[]; }

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Tier 2 — the JD term is in a resolved family's vocabulary AND the resume contains another vocab term from that group. */
function matchOntology(term: string, resumeLowerText: string, familyVocab: string[][]): boolean {
    const nt = normalizeTerm(term);
    if (!nt) return false;
    const resume = ' ' + resumeLowerText.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    for (const group of familyVocab) {
        const normGroup = group.map(normalizeTerm).filter(Boolean);
        if (!normGroup.includes(nt)) continue;
        if (normGroup.some((v) => v !== nt && resume.includes(` ${v} `))) return true;
    }
    return false;
}

/** 3-tier match. Tier 3 (embedding) only runs on tier1+2 misses; fail-open. */
export async function matchTerm(term: string, resumeLowerText: string, ctx: MatchCtx): Promise<{ present: boolean; tier: MatchTier }> {
    if (resumeLowerText.toLowerCase().includes(term.toLowerCase().trim())) return { present: true, tier: 'literal' };
    if (matchTier1(term, resumeLowerText)) return { present: true, tier: 'normalized' };
    if (matchOntology(term, resumeLowerText, ctx.familyVocab)) return { present: true, tier: 'ontology' };
    if (ctx.embedder) {
        try {
            const rv = ctx.resumeVector ?? await ctx.embedder.embed(resumeLowerText.slice(0, 8000));
            const tv = await ctx.embedder.embed(term);
            if (cosine(rv, tv) >= ctx.threshold) return { present: true, tier: 'embedding' };
        } catch { /* fail-open — no false credit */ }
    }
    return { present: false, tier: 'none' };
}
```
NOTE: for run efficiency, the caller embeds the resume ONCE and passes `resumeVector` in `ctx` (see Task 3) so only terms are embedded per call.

- [ ] **Step 3:** `yarn test keyword-match` → pass; `npx tsc --noEmit` clean. Commit `feat(ats): ontology + embedding keyword tiers (matchTerm)`.

---

## Task 3: wire into checks + ATS check + pipeline (+ schema tier)

**Files:** `ats-check.schema.ts`, `checks.ts` + test, `run-ats-check.ts`, `run-pipeline.ts`.

- [ ] **Step 1: schema** — `ats-check.schema.ts` `AtsKeywordCoverageSchema` gains `tier: z.enum(['literal','normalized','ontology','embedding','none']).default('none')` (additive, back-compat).

- [ ] **Step 2: checks.ts** — the coverage builder currently does `present: lower.includes(term.toLowerCase())`. Replace with `matchTerm`. Since `runChecks`/`deriveAtsResult` is sync, make the coverage computation async (await each `matchTerm`), OR pass a pre-computed coverage array in. Cleanest: compute coverage in `run-ats-check.ts` (async, has the embedder) and pass the `Coverage` array (with `tier`) into the pure `checks.ts` builder (which already takes `facts.coverage` — confirm; if `checks.ts` builds coverage internally, lift that out to run-ats-check). Keep `grounded` as today.

- [ ] **Step 3: run-ats-check.ts** — `renderCheckAndStoreAts`/`runAtsCheck` gain params `jdExtraction: JdExtraction | null`, `familyVocab: string[][]`, `embedder: Embedder | null`. Use `collectJdMustHavesV2(jdExtraction, research)`; embed the resume text ONCE; for each must-have call `matchTerm(term, resumeText, { familyVocab, embedder, threshold, resumeVector })`. Build the coverage with `tier`. `threshold` from `process.env['ATS_KEYWORD_EMBED_THRESHOLD'] ?? 0.55`. Fail-open: embedder errors degrade to tiers 1-2.

- [ ] **Step 4: run-pipeline.ts** — capture the resolved families (currently inlined in `formatRoleEvidence`): `const resolved = await resolveRoleFamilies(...).catch(() => []); const roleEvidenceBlock = formatRoleEvidence(resolved, companyFraming);` then `const familyVocab = resolved.map((r) => r.family?.vocabulary ?? []).filter((v) => v.length > 0);`. Pass `jdExtraction`, `familyVocab`, and a shared `TitanEmbeddingProvider.fromEnvironment()` embedder into `renderCheckAndStoreAts`.

- [ ] **Step 5: tests** — update `checks.test.ts` for the `tier` field; add a `run-ats-check` test that a phrase JD term ("Critical thinking and root cause analysis") now matches a resume containing "root-cause analysis" (tier normalized), and a genuine gap ("ChatGPT") stays absent. Mock the embedder.

- [ ] **Step 6:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → green. Commit `feat(ats): wire atomic+3-tier keyword coverage into the ATS check + pipeline`, then `git push -u origin feat/ats-keyword-v2` and open a PR → develop.

---

## Deploy + verify
- PR → develop → build → SSM → job-strategist.
- Re-run the same JD → ATS keyword coverage should jump from 2/15 to a true count (Python/root-cause/automation/troubleshooting credited via normalized/ontology; genuine gaps like ChatGPT/OpenAI API still absent). The `tier` on each coverage row shows how each was credited.
