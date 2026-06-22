# Free-Tier JD Resume Generator — Narrative-First, Lean

- **Date:** 2026-06-22
- **Status:** Design approved, awaiting spec review
- **Owner:** Nelson Lamounier
- **Scope:** ai-applications `job-strategist` only. The admin-api plan→MODE gate is a
  separate tucaken-app follow-up.

## Problem

The paid JD→resume pipeline (`mode='standard'`) runs a heavy chain: JD extraction →
research **matcher** (verified/partial/gap) → **skill-evidence ledger** → strategist
agent (4-phase persona, resume + cover letter) → ATS **attainable-keyword feedback
re-write** → provenance audit. That machinery powers the **"skills evidence overview"**
(the verified/partial/gap panel) and costs extra LLM calls (the Haiku matcher plus a
second Sonnet `surfaceKeywords` pass).

We want a **free tier** that still lets a user generate a **tailored, ATS-aware resume
and cover letter**, but **without** the skills-evidence overview and **without** the
extra LLM charges. The free path should be a leaner, narrative-first generation grounded
in the user's own data.

## Goals

- A `MODE='free'` branch in the job-strategist pipeline that produces a tailored
  **resume (`content_json`) + cover letter**, persisted exactly like the paid tier so
  the existing UI renders them.
- Narrative-first writing: impact-bullet storytelling, grounded in the user's evidence,
  **no hallucination**.
- **ATS keyword coverage that is grounded** — the resume weaves in the JD's extracted
  skills/keywords, but only where the user's evidence supports them; plus a
  deterministic coverage report.
- Strictly **leaner and cheaper than paid**: no research matcher, no skill-evidence
  ledger, no attainable-keyword re-write, no provenance audit.

## Non-goals (explicitly out of scope)

- **The free/paid gate.** `users.plan` lives in tucaken-app (admin-api), which already
  passes a `MODE` env var to the Job. This spec builds the engine and defines the MODE
  contract; the admin-api change (read `users.plan` → send `MODE='free'` for
  free/expired-trial users) is a small separate tucaken-app PR.
- **Persisting the JD scan as its own record.** The `JdSignal` stays in-memory and flows
  to the writer, as today.
- Any change to paid-tier (`mode='standard'`) behaviour.
- The "skills evidence overview" / verified-partial-gap panel (a paid feature).

## Data diet

| Source | Free tier | Notes |
|---|---|---|
| JD signal (skills, tools, keywords, `companyProblem`) | **Keep** | `extractJdSignal` (already raised to 8192 maxTokens) |
| RAG KB (hybrid vector+keyword search, Bedrock rerank, `[Source: repo/path]` citations) | **Keep** | reuse `querySingleRds` retrieval |
| Project case-study evidence (`projects`, `project_*` tables) | **Keep** | `loadProjectEvidenceBlock` |
| Extracted technologies (`technology_evidence` + code-file proof) | **Keep** | `TechnologyOntologyRepository` |
| Verbatim career + education facts | **Keep** | existing facts loaders; never invented |
| Skill-ontology (`skill_ontology`/`skill_aliases`) | **Keep — canonicalisation only** | cheap DB lookups; synonym map for ATS coverage (k8s≡Kubernetes). NO ledger. |
| Research matcher (verified/partial/gap) | **Drop** | the extra Haiku call; not needed for narrative |
| Skill-evidence ledger / "skills evidence overview" | **Drop** | the paid panel |
| Attainable-keyword feedback re-write (`splitAttainable`/`surfaceKeywords`) | **Drop** | extra Sonnet pass |
| Evidence-provenance audit | **Drop** | observability side-channel |

## Architecture

A `mode === 'free'` fork in `run-pipeline.ts` runs a lean sub-pipeline. The paid path is
untouched.

```
JD text
  │  LLM #1 — reuse extractJdSignal
{ requiredSkills, preferredSkills, tools, retrievalKeywords, companyProblem }
  │
  ▼  Evidence gather (gatherFreeEvidence) — NO matcher, NO ledger
   • RAG: hybrid search + Bedrock rerank + [Source: repo/path] citations (reuse querySingleRds)
   • Project case-study evidence block (loadProjectEvidenceBlock)
   • Extracted technologies + code file proof (technology_evidence)
   • Verbatim career + education facts
  │
  ▼  LLM #2 — NEW free-resume-writer (Sonnet)
{ resume: StructuredResumeData, coverLetter: CoverLetter }
  │
  ▼  Grounded ATS coverage (deterministic, NO LLM)
   which JD keywords landed in the resume, skill-ontology synonym-aware
  │
  ▼  Cover-letter guard (reuse guardCoverLetter) + grounding verifier (flag mode, existing)
  │
  ▼  persistTailoredResume → resumes (content_json, cover letter, source_chunk_ids=cited chunks,
                                       ats_check_json = lean coverage report)
```

### Component 1 — JD scan (LLM #1, reuse)

Reuse `extractJdSignal` ([jd-extractor.ts](../../../applications/job-strategist/src/agents/jd-extractor.ts)).
Free mode consumes a subset of its output: `requiredSkills`, `preferredSkills`, `tools`,
`retrievalKeywords`, and `companyProblem`. No new code; no separate persistence.

### Component 2 — Evidence gather (`free/gather-evidence.ts`, new)

A single reusable function `gatherFreeEvidence(pool, env, jdSignal)` returning a
`FreeEvidence` object:

```ts
interface FreeEvidence {
  kbPassages: string[];        // "[Source: repo/path, Cosine, Rerank]\n<text>" — reuse querySingleRds
  projectEvidence: string;     // loadProjectEvidenceBlock(...)
  extractedTech: string;       // technology_evidence summary + code-file proof
  careerFacts: string;         // verbatim company/title/period
  educationFacts: string;      // verbatim degree/institution
}
```

- RAG queries are the JD-derived `jdRetrievalQueries(jdSignal)` skill/experience/project
  queries (now never empty after the truncation fix) run through `querySingleRds`
  (hybrid + rerank + citations). The DORA/static query is optional here (keep for
  outcome metrics).
- This isolates the lean path's retrieval from the heavy research agent — no matcher,
  no skill-ontology resolution beyond canonicalisation.

### Component 3 — Narrative writer (`agents/free-resume-writer.ts` + `prompts/free-resume-persona.ts`, new)

A new Sonnet agent. **Input:** `{ jdSignal subset, FreeEvidence }`. **Output (forced
tool / structured):** `{ resume: StructuredResumeData, coverLetter: CoverLetter }` —
reusing the existing `StructuredResumeData` and `CoverLetter` shapes so persistence and
the UI are unchanged.

System prompt encodes the storytelling contract:

- **Impact bullet = action verb → what you did → why it mattered → numbers → technology**,
  1–2 lines, one complete story. Example shape: *"Revamped narrator search for 1.3M
  users on AWS OpenSearch, cutting query latency and enforcing GDPR compliance."*
- **Anti-hallucination (hard rule):** numbers, employers, dates, and skills may appear
  **only** when `FreeEvidence` supports them. No evidence → no metric. Career/education
  facts are used **verbatim** (no invented employers/dates).
- **Grounded ATS weaving:** incorporate the JD's `requiredSkills`/`tools`/`keywords`
  **only where a passage / project / extracted technology backs them**; otherwise omit.
- **Cover letter:** anchored in the JD's `companyProblem` + the candidate's evidence — a
  narrative connecting real work to the company's problem; same anti-hallucination rule.
- Citations are used internally for grounding and stored in `source_chunk_ids`; resume
  bullets stay clean (no inline `[Source: …]`).

The writer SKIPS the paid strategist's archetype-selection and 4-phase analysis — it is a
focused narrative generator, not the full persona.

### Component 4 — Grounded ATS coverage (`ats/grounded-coverage.ts`, new)

Deterministic, no LLM. After the writer returns:

```ts
function groundedAtsCoverage(
  resumeText: string,
  jdKeywords: string[],                 // requiredSkills ∪ tools ∪ retrievalKeywords
  aliasToCanonical: Map<string,string>, // skill-ontology canonicalisation
): { covered: string[]; missing: string[]; coverageRate: number };
```

- Canonicalise both the JD keywords and the resume tokens via the skill-ontology alias
  map, then set-match. So a JD "k8s" is counted as covered by a resume "Kubernetes".
- Output is a **lean coverage report** (covered / missing / rate) stored in
  `ats_check_json` — **not** the verified/partial/gap ledger.
- Cannot hallucinate: the writer only used evidence-backed keywords; this is pure
  string matching over what landed.

### Component 5 — Guards + persistence (reuse)

- `guardCoverLetter` on the cover letter (existing validator).
- Grounding verifier in **flag mode** (existing) over writer output vs `kbPassages` —
  anti-hallucination telemetry, no blocking.
- `persistTailoredResume` writes `resumes` (content_json, cover letter,
  `source_chunk_ids` = cited chunk ids, `ats_check_json` = lean coverage). Identical
  storage to paid, so the UI renders resume + cover letter; the skills-evidence overview
  panel simply has no ledger data on the free tier.

### Component 6 — MODE plumbing (`env.ts`, `run-pipeline.ts`)

- `env.ts`: validate `MODE` as an enum that includes `'free'` (default `'standard'`).
- `run-pipeline.ts`: at the top of `main()`, branch — `mode === 'free'` runs the lean
  sub-pipeline (Components 1–5); any other value runs today's pipeline unchanged.

## Eval (per CLAUDE.md §5 — non-negotiable for an LLM workflow)

`agents/free-resume-writer.eval.test.ts`, mirroring existing eval style, with fixtures:

1. **No fabrication** — every number, employer, date, and named skill in the output
   appears in the supplied `FreeEvidence`. A fabricating model fixture is rejected.
2. **Grounded ATS coverage** — JD keywords that ARE backed by evidence surface in the
   resume; keywords with no evidence do NOT appear.
3. **Impact-bullet format** — bullets begin with an action verb and respect the length
   bound (≤ ~2 lines / character cap).
4. **Cover letter honesty** — the cover letter invents no employer/metric/claim beyond
   the evidence and references the `companyProblem`.

Deterministic graders where possible (string/format checks like the case-study
graders); a small injectable judge only for the subjective "reads as grounded narrative"
dimension, env-flagged so CI stays Bedrock-free.

## Acceptance criteria

- `MODE='free'` produces a persisted `resumes` row with a tailored `content_json` +
  cover letter, and a lean `ats_check_json` coverage report — no skill-evidence ledger,
  no provenance rows.
- `MODE='standard'` (and any non-`free` value) behaviour is byte-for-byte unchanged.
- The writer's output passes the four eval checks on the fixtures.
- Free path makes **no more LLM calls than**: 1 extraction + embeddings/rerank + 1
  writer (+ existing flag-mode grounding verifier). It does NOT invoke the matcher or a
  `surfaceKeywords` pass.
- ESLint clean; no migration required (reuses `resumes`).

## Risks & mitigations

- **"Always include numbers" vs no-fabrication.** The prompt resolves the tension
  explicitly: include a metric only when evidence provides it; otherwise lead with the
  impact qualitatively. The eval's no-fabrication grader is the guard.
- **Sparse skill-ontology coverage** (known: low canonical coverage) weakens synonym
  matching in the ATS check. Mitigation: fall back to case-insensitive exact match when
  no alias maps; coverage degrades gracefully, never crashes.
- **Empty RAG for a thin portfolio.** `gatherFreeEvidence` must tolerate empty passages
  (the writer then grounds on project + career facts); never send an empty embedding
  query (the truncation-fix guard already covers this).
- **Schema drift between free and paid `StructuredResumeData`.** Reuse the shared types
  verbatim; do not fork the resume schema.
