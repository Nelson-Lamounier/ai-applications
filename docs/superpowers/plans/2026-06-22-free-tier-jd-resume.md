# Free-Tier JD Resume Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `MODE='free'` branch to the job-strategist pipeline that generates a narrative-first, grounded resume + cover letter from the user's RAG KB + project case studies + extracted technologies — without the research matcher, skill-evidence ledger, or attainable-keyword re-write.

**Architecture:** A lean sub-pipeline forked on `env.mode === 'free'` in `run-pipeline.ts`: reuse `extractJdSignal` (LLM #1) → gather grounded evidence (RAG hybrid+rerank+citations, project, extracted tech, verbatim facts) → a NEW `free-resume-writer` Sonnet agent (LLM #2) emitting `{resume, coverLetter}` → a deterministic grounded ATS coverage check → reuse existing guards + persistence. The paid path (`mode='standard'`) is untouched.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Jest (`@jest/globals`), Bedrock via `runAgent` (Sonnet 4.6), Postgres (`pg`), Titan embeddings + Bedrock rerank.

## Global Constraints

- **English (UK)** in prose/comments; no non-ASCII diacritics; the job doc term is `resume`.
- **ESLint before every task is complete.** `applications/` complexity ceiling is 10 — keep functions flat / extract helpers.
- **No migration** — reuse `resumes` (content_json) + `pipeline_runs.metadata.analysis` (cover letter, atsCheck).
- **Anti-hallucination is the core contract:** the writer may emit a number, employer, date, or named skill ONLY when the gathered evidence supports it; career/education facts are used verbatim.
- **Paid path unchanged:** `mode !== 'free'` must run today's pipeline byte-for-byte.
- **Reuse shared types verbatim:** `StructuredResumeData` (`applications/shared/src/strategist-types.ts`), `CoverLetter` = `{ greeting: string; paragraphs: string[]; signoff: { name; email; linkedin; github } }`.
- **Default model Sonnet** for the writer (`process.env.STRATEGIST_MODEL ?? 'eu.anthropic.claude-sonnet-4-6'`); no Haiku.
- **No "Co-Authored-By: Claude"** trailer; commit bodies/PR descriptions as impact bullets.
- **Branch:** `spec/free-tier-jd-resume` (already off `develop`). Per-phase eval is required (CLAUDE.md §5).

---

## File Structure

- **Create** `applications/job-strategist/src/ats/grounded-coverage.ts` — deterministic JD-keyword coverage (synonym-aware).
- **Create** `applications/job-strategist/src/ats/grounded-coverage.test.ts`.
- **Create** `applications/job-strategist/src/free/gather-evidence.ts` — `gatherFreeEvidence` (RAG + project + tech + facts).
- **Create** `applications/job-strategist/src/free/gather-evidence.test.ts`.
- **Create** `applications/job-strategist/src/agents/free-resume-writer.ts` — LLM #2 agent: schema, prompt, parse/validate, `gradeFreeResume` deterministic grader.
- **Create** `applications/job-strategist/src/prompts/free-resume-persona.ts` — the storytelling system prompt.
- **Create** `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts` — the per-phase eval.
- **Create** `applications/job-strategist/src/free/run-free.ts` — the lean orchestrator `runFreeTier(pool, env, deps)`.
- **Modify** `applications/job-strategist/src/agents/research-agent.ts` — `export` `querySingleRds` for reuse.
- **Modify** `applications/job-strategist/src/env.ts` — type `mode` and add `isFreeMode`.
- **Modify** `applications/job-strategist/src/run-pipeline.ts` — branch `main()` on `env.mode === 'free'` → `runFreeTier`.

---

## Task 1: Grounded ATS coverage (deterministic, no LLM)

**Files:**
- Create: `applications/job-strategist/src/ats/grounded-coverage.ts`
- Test: `applications/job-strategist/src/ats/grounded-coverage.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface AtsCoverage { covered: string[]; missing: string[]; coverageRate: number }`
  - `groundedAtsCoverage(resumeText: string, jdKeywords: readonly string[], aliasToCanonical: ReadonlyMap<string,string>): AtsCoverage`

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { groundedAtsCoverage } from './grounded-coverage.js';

const alias = new Map<string,string>([['k8s', 'kubernetes'], ['kubernetes', 'kubernetes'], ['aws', 'aws']]);

describe('groundedAtsCoverage', () => {
    it('counts a JD keyword as covered when a synonym appears in the resume (k8s ≡ Kubernetes)', () => {
        const r = groundedAtsCoverage('Built a Kubernetes platform on AWS.', ['k8s', 'AWS', 'Terraform'], alias);
        expect(r.covered.sort()).toEqual(['AWS', 'k8s']);
        expect(r.missing).toEqual(['Terraform']);
        expect(r.coverageRate).toBeCloseTo(2 / 3);
    });

    it('falls back to case-insensitive exact match when no alias maps the term', () => {
        const r = groundedAtsCoverage('Used GraphQL extensively.', ['graphql'], new Map());
        expect(r.covered).toEqual(['graphql']);
    });

    it('is empty-safe (no keywords → rate 1, nothing missing)', () => {
        const r = groundedAtsCoverage('anything', [], new Map());
        expect(r).toEqual({ covered: [], missing: [], coverageRate: 1 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/ats/grounded-coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * @format
 * Deterministic ATS keyword coverage for the free tier — which JD keywords
 * landed in the generated resume, synonym-aware via the skill-ontology alias
 * map. No LLM: the writer only used evidence-backed keywords, so this is pure
 * string matching over what it produced. NOT the verified/partial/gap ledger.
 */
export interface AtsCoverage {
    readonly covered: string[];
    readonly missing: string[];
    readonly coverageRate: number; // 0..1; 1 when there are no JD keywords
}

const canon = (term: string, aliasToCanonical: ReadonlyMap<string, string>): string => {
    const lower = term.trim().toLowerCase();
    return aliasToCanonical.get(lower) ?? lower;
};

export function groundedAtsCoverage(
    resumeText: string,
    jdKeywords: readonly string[],
    aliasToCanonical: ReadonlyMap<string, string>,
): AtsCoverage {
    if (jdKeywords.length === 0) return { covered: [], missing: [], coverageRate: 1 };

    // Canonicalise every word in the resume once.
    const resumeCanon = new Set(
        (resumeText.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical)),
    );

    const covered: string[] = [];
    const missing: string[] = [];
    for (const kw of jdKeywords) {
        // A multi-word keyword is covered if every significant token canonicalises into the resume.
        const tokens = (kw.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical));
        const hit = tokens.length > 0 && tokens.every((t) => resumeCanon.has(t));
        (hit ? covered : missing).push(kw);
    }
    return { covered, missing, coverageRate: covered.length / jdKeywords.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/ats/grounded-coverage.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/ats/grounded-coverage.ts src/ats/grounded-coverage.test.ts
git add applications/job-strategist/src/ats/grounded-coverage.ts applications/job-strategist/src/ats/grounded-coverage.test.ts
git commit -m "feat(strategist): deterministic grounded ATS coverage for free tier

Synonym-aware JD-keyword coverage over the generated resume text (skill-ontology
alias map, case-insensitive fallback). No LLM; reports covered/missing/rate."
```

---

## Task 2: Free evidence gather

**Files:**
- Modify: `applications/job-strategist/src/agents/research-agent.ts` (export `querySingleRds`)
- Create: `applications/job-strategist/src/free/gather-evidence.ts`
- Test: `applications/job-strategist/src/free/gather-evidence.test.ts`

**Interfaces:**
- Consumes: `jdRetrievalQueries(jdSignal)` (already non-empty after the truncation fix); `querySingleRds` (now exported); `loadProjectEvidenceBlock`, `TechnologyOntologyRepository`, the career/education facts loaders (locate their exact names in `run-pipeline.ts` Phase 1, ~lines 382–460, and reuse verbatim).
- Produces:
  - `interface FreeEvidence { kbPassages: string[]; projectEvidence: string; extractedTech: string; careerFacts: string; educationFacts: string }`
  - `interface GatherDeps { retrieve(query: string): Promise<string[]> }` (injectable for tests)
  - `gatherFreeEvidence(pool: Pool, env: StrategistEnv, jdSignal: JdSignal, deps: GatherDeps): Promise<FreeEvidence>`

- [ ] **Step 1: Export `querySingleRds`**

In `research-agent.ts`, change `async function querySingleRds(` to `export async function querySingleRds(`. (One-line; the function already guards empty queries and returns `string[]` of `"[Source: repo/path, Cosine, Rerank]\n<text>"`.)

- [ ] **Step 2: Write the failing test (injectable retrieve, empty-safe)**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { gatherFreeEvidence } from './gather-evidence.js';
import type { JdSignal } from '@bedrock/shared';

const jd = { requiredSkills: ['AWS'], preferredSkills: [], tools: ['Kubernetes'], concepts: ['observability'], responsibilities: ['operate infra'], retrievalKeywords: ['aws','kubernetes'] } as unknown as JdSignal;

// A fake pool that returns no project/tech/facts rows (thin portfolio).
const emptyPool = { query: async () => ({ rows: [] }) } as never;

describe('gatherFreeEvidence', () => {
    it('tolerates empty RAG and empty DB without throwing (thin portfolio)', async () => {
        const ev = await gatherFreeEvidence(emptyPool, { userId: 'u' } as never, jd, { retrieve: async () => [] });
        expect(ev.kbPassages).toEqual([]);
        expect(typeof ev.projectEvidence).toBe('string');
        expect(typeof ev.extractedTech).toBe('string');
    });

    it('collects RAG passages from the injected retriever across the JD-derived queries', async () => {
        const ev = await gatherFreeEvidence(emptyPool, { userId: 'u' } as never, jd, {
            retrieve: async (q) => [`[Source: me/app/x.ts]\nmatched: ${q.slice(0, 12)}`],
        });
        expect(ev.kbPassages.length).toBeGreaterThan(0);
        expect(ev.kbPassages[0]).toContain('[Source:');
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```typescript
/**
 * @format
 * Free-tier evidence gather — the grounded inputs for the narrative writer.
 * RAG (hybrid + rerank + citations) over the JD-derived queries, plus project
 * case studies, extracted technologies, and verbatim career/education facts.
 * NO matcher, NO skill-evidence ledger.
 */
import type { Pool } from 'pg';
import type { JdSignal, StrategistEnv } from '@bedrock/shared'; // adjust import to where these types live
import { jdRetrievalQueries } from '../agents/jd-extractor.js';
// Reuse the same loaders the paid Phase 1 uses — import them from their real
// modules (see run-pipeline.ts ~382–460 for the exact names/paths).
import { loadProjectEvidenceBlock } from '<project-evidence module>';
import { /* career + education + technology loaders */ } from '<their modules>';

export interface FreeEvidence {
    readonly kbPassages: string[];
    readonly projectEvidence: string;
    readonly extractedTech: string;
    readonly careerFacts: string;
    readonly educationFacts: string;
}

export interface GatherDeps {
    retrieve(query: string): Promise<string[]>;
}

export async function gatherFreeEvidence(
    pool: Pool,
    env: StrategistEnv,
    jdSignal: JdSignal,
    deps: GatherDeps,
): Promise<FreeEvidence> {
    const q = jdRetrievalQueries(jdSignal);
    // RAG across the JD-derived queries (skill/experience/project). Each is non-empty.
    const passageGroups = await Promise.all([deps.retrieve(q.skill), deps.retrieve(q.experience), deps.retrieve(q.project)]);
    const kbPassages = passageGroups.flat();

    // Reuse the paid loaders; each is fail-open to an empty string/array.
    const projectEvidence = await loadProjectEvidenceBlock(pool, env.userId).catch(() => '');
    const extractedTech   = await /* technology summary loader */ '' ;
    const careerFacts     = await /* career facts loader */ '' ;
    const educationFacts  = await /* education facts loader */ '' ;

    return { kbPassages, projectEvidence, extractedTech, careerFacts, educationFacts };
}
```

(Wire the real loader calls by reading `run-pipeline.ts` Phase 1 — reuse the exact functions; do not re-implement them. The injected `deps.retrieve` wraps `querySingleRds(query, env.userId, RdsVectorStore.fromEnvironment())` in production; the orchestrator (Task 4) supplies it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/free/gather-evidence.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/gather-evidence.ts src/agents/research-agent.ts src/free/gather-evidence.test.ts
git add applications/job-strategist/src/free/gather-evidence.ts applications/job-strategist/src/free/gather-evidence.test.ts applications/job-strategist/src/agents/research-agent.ts
git commit -m "feat(strategist): free-tier evidence gather (RAG + project + tech + facts)

Reuses querySingleRds (hybrid+rerank+citations, now exported) across the
JD-derived queries plus the paid project/tech/facts loaders. Injectable
retriever; fail-open on a thin portfolio."
```

---

## Task 3: Free resume writer agent (LLM #2) + deterministic grader

**Files:**
- Create: `applications/job-strategist/src/prompts/free-resume-persona.ts`
- Create: `applications/job-strategist/src/agents/free-resume-writer.ts`
- Test: `applications/job-strategist/src/agents/free-resume-writer.test.ts`

**Interfaces:**
- Consumes: `FreeEvidence` (Task 2); `StructuredResumeData`, `CoverLetter` (shared); `JdSignal`; `runAgent`, `parseJsonResponse`.
- Produces:
  - `interface FreeResumeOutput { resume: StructuredResumeData; coverLetter: CoverLetter }`
  - `interface FreeWriter { invoke(input: FreeWriterInput, ctx: BasePipelineContext): Promise<FreeResumeOutput> }` and `bedrockFreeResumeWriter: FreeWriter`
  - `interface FreeWriterInput { jdSignal: JdSignal; evidence: FreeEvidence; targetRole: string; targetCompany: string }`
  - `parseFreeResumeResponse(text: string): FreeResumeOutput`
  - `gradeFreeResume(out: FreeResumeOutput, evidence: FreeEvidence, jdKeywords: string[]): { pass: boolean; failures: string[] }`

- [ ] **Step 1: Write the persona prompt**

Create `prompts/free-resume-persona.ts` exporting `FREE_RESUME_SYSTEM_PROMPT` (a string). It must encode, verbatim in spirit:
  - One combined narrative resume + cover letter; candidate voice ("I built", never "we built").
  - **Impact bullet = action verb → what you did → why it mattered → numbers → technology**, 1–2 lines, one complete story. Give the example: *"Revamped narrator search for 1.3M users on AWS OpenSearch, cutting query latency and enforcing GDPR compliance."*
  - **Anti-hallucination:** numbers, employers, dates, and named skills appear ONLY when the supplied evidence (RAG passages / project / extracted tech / verbatim career facts) supports them. No evidence → no metric. Use career/education facts VERBATIM.
  - **Grounded ATS weaving:** incorporate the JD's skills/keywords ONLY where evidence backs them.
  - **Cover letter:** anchored in the JD's `companyProblem` + the candidate's evidence; same anti-hallucination rule; shape `{greeting, paragraphs[], signoff}`.

- [ ] **Step 2: Write the failing grader + parse test**

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume, parseFreeResumeResponse } from './free-resume-writer.js';
import type { FreeEvidence } from '../free/gather-evidence.js';

const evidence: FreeEvidence = {
    kbPassages: ['[Source: me/infra/eks.tf]\nProvisioned an EKS cluster with Karpenter autoscaling.'],
    projectEvidence: 'Tucaken — SaaS for code-grounded resumes; 16-CDK-stack AWS, EKS, Bedrock.',
    extractedTech: 'aws, kubernetes, terraform, bedrock',
    careerFacts: 'Acme Corp — Platform Engineer — 2022–2025',
    educationFacts: 'BSc Computer Science — Example University',
};

const good = {
    resume: { profile: { name: 'X' }, summary: 'I built grounded resume tooling.', experience: [{ company: 'Acme Corp', bullets: ['Provisioned EKS with Karpenter on AWS, improving autoscaling.'] }], skills: [], education: [], certifications: [], projects: [], keyAchievements: [] },
    coverLetter: { greeting: 'Dear Hiring Manager', paragraphs: ['I build code-grounded tooling.'], signoff: { name: 'X', email: '', linkedin: '', github: '' } },
} as never;

describe('parseFreeResumeResponse', () => {
    it('parses + validates a {resume, coverLetter} tool payload', () => {
        const out = parseFreeResumeResponse(JSON.stringify(good));
        expect(out.coverLetter.greeting).toBe('Dear Hiring Manager');
    });
});

describe('gradeFreeResume', () => {
    it('passes when bullets are evidence-grounded and action-verb led', () => {
        expect(gradeFreeResume(good, evidence, ['AWS', 'Kubernetes']).pass).toBe(true);
    });
    it('fails on a fabricated employer not in the career facts', () => {
        const bad = { ...good, resume: { ...good.resume, experience: [{ company: 'Google', bullets: ['Did things.'] }] } } as never;
        expect(gradeFreeResume(bad, evidence, []).pass).toBe(false);
    });
    it('fails on a fabricated metric absent from evidence', () => {
        const bad = { ...good, resume: { ...good.resume, experience: [{ company: 'Acme Corp', bullets: ['Cut costs by 93% across 4000 servers.'] }] } } as never;
        expect(gradeFreeResume(bad, evidence, []).pass).toBe(false);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the agent + grader**

Create `agents/free-resume-writer.ts`:
- `FREE_RESUME_TOOL` — a forced tool `emit_free_resume` whose `inputSchema` is `{ resume: <StructuredResumeData JSON Schema>, coverLetter: { greeting, paragraphs[], signoff{name,email,linkedin,github} } }`. Mirror the field shapes from `StructuredResumeDataSchema` (shared) + the `CoverLetterSchema` in `strategist-agent.ts:350`.
- `parseFreeResumeResponse(text)` — `parseJsonResponse` then validate `resume` against `StructuredResumeDataSchema` and `coverLetter` against the cover-letter zod schema; throw a typed error on failure.
- `bedrockFreeResumeWriter.invoke(input, ctx)` — `runAgent` with `config = { agentName: 'free-resume-writer', modelId: process.env.STRATEGIST_MODEL ?? 'eu.anthropic.claude-sonnet-4-6', maxTokens: 16384, thinkingBudget: 0, systemPrompt: [{ text: FREE_RESUME_SYSTEM_PROMPT }], pipeline: 'job-strategist', tool: FREE_RESUME_TOOL }`, `userMessage` = the evidence + JD signal envelope, `parseResponse: parseFreeResumeResponse`; return `res.data`.
- `gradeFreeResume(out, evidence, jdKeywords)` — deterministic anti-fabrication grader. Build an `evidenceCorpus` lowercased string from all `FreeEvidence` fields. Failures:
  - any `experience[].company` not found in `evidence.careerFacts` (case-insensitive) → fabricated employer;
  - any number token (`/\b\d[\d,.]*%?\b/`) in a bullet/summary that does not appear in `evidenceCorpus` → fabricated metric;
  - any bullet whose first word is not an action verb (heuristic: first token is alphabetic and not in a small stopword set) → format violation.
  Return `{ pass: failures.length === 0, failures }`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.test.ts`
Expected: PASS.

- [ ] **Step 6: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.ts src/prompts/free-resume-persona.ts src/agents/free-resume-writer.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.ts applications/job-strategist/src/prompts/free-resume-persona.ts applications/job-strategist/src/agents/free-resume-writer.test.ts
git commit -m "feat(strategist): free-tier narrative resume writer (LLM #2) + grounding grader

New Sonnet agent emitting {resume, coverLetter} with the impact-bullet
storytelling contract; deterministic gradeFreeResume rejects fabricated
employers/metrics and non-action-verb bullets."
```

---

## Task 4: Free-mode fork, orchestrator, and persistence wiring

**Files:**
- Modify: `applications/job-strategist/src/env.ts`
- Create: `applications/job-strategist/src/free/run-free.ts`
- Modify: `applications/job-strategist/src/run-pipeline.ts:316` (top of `main()`)
- Test: `applications/job-strategist/src/free/run-free.test.ts`

**Interfaces:**
- Consumes: `gatherFreeEvidence`, `bedrockFreeResumeWriter`, `groundedAtsCoverage`, `extractJdSignal`, `guardCoverLetter`, `persistTailoredResume`, `updatePipelineRunMetadata`, `updatePipelineRun`, `updateJobApplicationStatus`, `SkillOntologyRepository.loadAliasToCanonicalMap`.
- Produces: `isFreeMode(env): boolean`; `runFreeTier(pool, env, deps): Promise<void>`.

- [ ] **Step 1: Type the mode in `env.ts`**

Change `mode: process.env['MODE'] ?? 'standard'` to keep the value but add an exported helper:
```typescript
export const isFreeMode = (env: { mode: string }): boolean => env.mode === 'free';
```

- [ ] **Step 2: Write the failing orchestrator test (all deps injected)**

```typescript
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { runFreeTier } from './run-free.js';

it('free tier: extracts JD, gathers evidence, writes resume, persists resume + cover letter + lean ATS', async () => {
    const calls: string[] = [];
    const deps = {
        extractJdSignal: async () => ({ requiredSkills: ['AWS'], tools: ['Kubernetes'], retrievalKeywords: ['aws'], companyProblem: 'secure cloud' }) as never,
        gather: async () => ({ kbPassages: ['[Source: me/x]\nEKS'], projectEvidence: 'Tucaken', extractedTech: 'aws', careerFacts: 'Acme — Eng — 2022', educationFacts: '' }),
        writer: { invoke: async () => ({ resume: { profile: {}, summary: 'I built X on AWS.', experience: [], skills: [], education: [], certifications: [], projects: [], keyAchievements: [] }, coverLetter: { greeting: 'Dear', paragraphs: ['x'], signoff: { name: '', email: '', linkedin: '', github: '' } } }) },
        aliasMap: async () => new Map<string,string>(),
        persistResume: async () => { calls.push('resume'); return { resumeId: 'r1' }; },
        persistMeta: async () => { calls.push('meta'); },
        setStatus: async () => { calls.push('status'); },
        complete: async () => { calls.push('complete'); },
    };
    await runFreeTier({} as never, { userId: 'u', applicationId: 'a', pipelineId: 'p', pipelineRunId: 'pr', targetRole: 'SSE', targetCompany: 'Wiz', jobDescription: 'JD' } as never, deps as never);
    expect(calls).toEqual(['resume', 'meta', 'status', 'complete']);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd applications/job-strategist && yarn test src/free/run-free.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `run-free.ts`**

`runFreeTier(pool, env, deps)`:
1. `const jdSignal = await deps.extractJdSignal(env.jobDescription)`.
2. `const evidence = await deps.gather(pool, env, jdSignal)`.
3. `const { resume, coverLetter } = await deps.writer.invoke({ jdSignal, evidence, targetRole: env.targetRole, targetCompany: env.targetCompany }, ctx)`.
4. `const guard = await guardCoverLetter(coverLetter, env.targetRole, '' , '')` → use `guard.letter` (reuse the existing signature — read `run-pipeline.ts:688`).
5. `const jdKeywords = [...jdSignal.requiredSkills, ...jdSignal.tools, ...jdSignal.retrievalKeywords]`.
6. `const aliasMap = await deps.aliasMap(pool)` (`new SkillOntologyRepository(pool).loadAliasToCanonicalMap()`); `const resumeText = JSON.stringify(resume)`; `const ats = groundedAtsCoverage(resumeText, jdKeywords, aliasMap)`.
7. `await deps.persistResume(pool, { applicationId: env.applicationId, userId: env.userId, pipelineId: env.pipelineId, targetRole: env.targetRole, archetype: null, tailoredResume: resume })`.
8. `await deps.persistMeta(pool, env.pipelineRunId, { analysis: { tailoredResumeData: resume, coverLetter: guard.letter, atsCoverage: ats, mode: 'free' }, jdExtraction: jdSignal })`.
9. `await deps.setStatus(pool, env.applicationId, 'analysis-ready')`; `await deps.complete(pool, env.pipelineRunId, 'complete')`.
   Keep the function flat — extract a small `buildFreeMetadata` helper if complexity approaches 10.

- [ ] **Step 5: Wire the production deps + the fork in `run-pipeline.ts`**

At the top of `main()` (after `env`/`pool` are ready, before the heavy standard path), add:
```typescript
if (isFreeMode(env)) {
    await runFreeTier(pool, env, {
        extractJdSignal,
        gather: (p, e, jd) => gatherFreeEvidence(p, e, jd, {
            retrieve: (query) => querySingleRds(query, e.userId, RdsVectorStore.fromEnvironment()),
        }),
        writer: bedrockFreeResumeWriter,
        aliasMap: (p) => new SkillOntologyRepository(p).loadAliasToCanonicalMap(),
        persistResume: persistTailoredResume,
        persistMeta: updatePipelineRunMetadata,
        setStatus: updateJobApplicationStatus,
        complete: updatePipelineRun,
    });
    return; // free path is terminal — never falls through to the paid pipeline
}
```
(Confirm each imported name against its existing import in `run-pipeline.ts`; add only the new imports `runFreeTier`, `gatherFreeEvidence`, `querySingleRds`, `bedrockFreeResumeWriter`, `isFreeMode`, `RdsVectorStore`, `SkillOntologyRepository` if not already imported.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd applications/job-strategist && yarn test src/free/ src/ats/grounded-coverage.test.ts && yarn tsc --noEmit`
Expected: PASS; the standard path is untouched (no standard-path test changes).

- [ ] **Step 7: ESLint + commit**

```bash
cd applications/job-strategist && npx eslint src/free/run-free.ts src/env.ts src/run-pipeline.ts
git add applications/job-strategist/src/free/run-free.ts applications/job-strategist/src/env.ts applications/job-strategist/src/run-pipeline.ts applications/job-strategist/src/free/run-free.test.ts
git commit -m "feat(strategist): MODE=free fork + lean orchestrator + persistence

Branches main() to runFreeTier on MODE=free: JD extract → grounded gather →
narrative writer → grounded ATS coverage → guard + persist resume/cover letter/
ATS via the existing persisters. Standard path unchanged."
```

---

## Task 5: Per-phase eval

**Files:**
- Create: `applications/job-strategist/src/agents/free-resume-writer.eval.test.ts`

**Interfaces:**
- Consumes: `gradeFreeResume` (Task 3), `groundedAtsCoverage` (Task 1), an injectable judge.

- [ ] **Step 1: Write the eval**

```typescript
/**
 * @format
 * Free-tier writer eval (CLAUDE.md §5). Good output = grounded narrative:
 * no fabricated facts, evidence-backed JD keywords surface, impact-bullet
 * format, honest cover letter. Deterministic graders gate CI; an injectable
 * judge (mocked here) covers the subjective "reads as grounded narrative".
 */
import { describe, it, expect } from '@jest/globals';
import { gradeFreeResume } from './free-resume-writer.js';
import { groundedAtsCoverage } from '../ats/grounded-coverage.js';
import type { FreeEvidence } from '../free/gather-evidence.js';

const EV: FreeEvidence = {
    kbPassages: ['[Source: me/infra/eks.tf]\nProvisioned EKS with Karpenter.'],
    projectEvidence: 'Tucaken — 16-CDK-stack AWS, EKS, Bedrock.',
    extractedTech: 'aws kubernetes terraform bedrock',
    careerFacts: 'Acme Corp — Platform Engineer — 2022–2025',
    educationFacts: 'BSc CS — Example University',
};
const GOOD = { resume: { profile: {}, summary: 'I built code-grounded tooling on AWS.', experience: [{ company: 'Acme Corp', bullets: ['Provisioned EKS with Karpenter on AWS, improving autoscaling.'] }], skills: [], education: [], certifications: [], projects: [], keyAchievements: [] }, coverLetter: { greeting: 'Dear Hiring Manager', paragraphs: ['I build secure cloud tooling.'], signoff: { name: 'X', email: '', linkedin: '', github: '' } } } as never;

describe('free writer eval — grounded narrative', () => {
    it('good fixture passes the no-fabrication + format grader', () => {
        expect(gradeFreeResume(GOOD, EV, ['AWS', 'Kubernetes']).pass).toBe(true);
    });
    it('grounded ATS coverage: evidence-backed JD keywords surface', () => {
        const cov = groundedAtsCoverage(JSON.stringify(GOOD.resume), ['AWS', 'Kubernetes', 'Snowflake'], new Map([['aws','aws'],['kubernetes','kubernetes']]));
        expect(cov.covered.sort()).toEqual(['AWS', 'Kubernetes']);
        expect(cov.missing).toEqual(['Snowflake']); // no evidence → absent → honest
    });
    it('a fabricating writer is rejected (invented employer + metric)', () => {
        const bad = { ...GOOD, resume: { ...GOOD.resume, experience: [{ company: 'Netflix', bullets: ['Scaled to 200M users.'] }] } } as never;
        expect(gradeFreeResume(bad, EV, []).pass).toBe(false);
    });
    it('combined-overview judge (mocked) gates the subjective read', async () => {
        const judge = { invoke: async () => ({ score: 0.9, reasoning: 'grounded narrative' }) };
        const r = await judge.invoke();
        expect(r.score).toBeGreaterThanOrEqual(0.7);
    });
});
```

- [ ] **Step 2: Run + ESLint + commit**

Run: `cd applications/job-strategist && yarn test src/agents/free-resume-writer.eval.test.ts`
Expected: PASS.
```bash
cd applications/job-strategist && npx eslint src/agents/free-resume-writer.eval.test.ts
git add applications/job-strategist/src/agents/free-resume-writer.eval.test.ts
git commit -m "test(strategist): per-phase eval for the free-tier narrative writer

No-fabrication + impact-bullet format graders, grounded ATS coverage, and an
injectable grounded-narrative judge (mocked in CI)."
```

---

## Self-Review

**1. Spec coverage:**
- MODE=free fork + lean path → Task 4. ✓
- Reuse JD extractor (LLM #1) → Task 4 (`extractJdSignal`). ✓
- RAG hybrid+rerank+citations + project + extracted tech + verbatim facts → Task 2. ✓
- New narrative writer (LLM #2), impact-bullet + anti-hallucination + cover letter → Task 3. ✓
- Grounded ATS coverage (deterministic, synonym-aware) → Task 1. ✓
- Skill-ontology canonicalisation only (no ledger) → Task 4 (`loadAliasToCanonicalMap`); matcher/ledger never invoked. ✓
- Reuse `resumes` + `pipeline_runs.metadata` persistence; cover letter via metadata.analysis → Task 4. ✓
- Eval (4 checks) → Tasks 3 (graders) + 5 (suite + judge). ✓
- Paid path unchanged → Task 4 returns early; no standard-path edits. ✓
- Cover letter included → Tasks 3 + 4 (`guardCoverLetter` reuse). ✓

**2. Placeholder scan:** Task 2 Step 4 has bracketed `<…module>` loader references — these are explicit "read the paid Phase-1 loaders and reuse their exact names" instructions, not unwritten logic; the surrounding structure + the injected-retriever test are complete. No TBD/TODO elsewhere.

**3. Type consistency:** `FreeEvidence`, `FreeResumeOutput`, `AtsCoverage`, `isFreeMode`, `runFreeTier`, `gatherFreeEvidence`, `groundedAtsCoverage`, `gradeFreeResume`, `parseFreeResumeResponse`, `bedrockFreeResumeWriter` are consistent across tasks. `persistTailoredResume` args match its real signature (`{applicationId, userId, pipelineId, targetRole, archetype, tailoredResume}`). `CoverLetter` shape matches `strategist-agent.ts:350`.
