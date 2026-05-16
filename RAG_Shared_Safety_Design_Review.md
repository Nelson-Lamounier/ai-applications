# RAG Checklist — Per-App Split + Shared Safety Modules (Sub-project 1)

**Date:** 2026-05-16
**Status:** Approved (design)
**Author:** Nelson Lamounier (with Claude Code)

## Context

`Rag-deployment-check-list.md` was written for the chatbot but applies, in
scoped form, to every LLM-calling app in this monorepo. An audit of five apps
(chatbot, job-strategist, ingestion, resume-import-processor, article-pipeline)
found the real gaps cluster in checklist §5–7 (PII, grounding, zero-result) and
are fixable once in shared code rather than five times per app.

Full implementation across five apps is too large for one spec. It is
decomposed into sequenced sub-projects, each with its own spec → plan → build:

- **Sub-project 1 (this spec):** per-app split checklist docs, GitHub issues,
  and the two shared safety modules (PII scrubber, grounding verifier) **with
  tests only** — no per-app wiring.
- **Sub-project 2 (future, issue-driven):** wire shared modules into all 5 apps.
- **Sub-project 3 (future):** semantic cache for the query apps.

## Goals

1. Split the monolithic checklist into a per-app model that distinguishes the
   **RAG-Retrieval subset** (§1–4, 8, 9) from the **LLM-Safety subset**
   (§5–7, applies to every app that calls an LLM).
2. Open two tracking GitHub issues for the shared modules with per-app
   acceptance checklists.
3. Build a shared **PII scrubber** module — pluggable detector, regex default,
   Comprehend hook stub, redaction (not just warn).
4. Build a shared **grounding verifier** module — checklist §6 LLM check,
   configurable block-vs-flag per app, metric emission.

Non-goals (explicitly out of scope for sub-project 1): wiring the modules into
any app, semantic cache, Comprehend implementation, reversible PII rehydration.

## A. Per-App Split Checklist Docs

`Rag-deployment-check-list.md` stays unchanged as the chatbot canonical
reference. New tracked directory `rag-checklist/` at repo root (note: `docs/`
is gitignored — checklist docs follow the existing root-level review
convention):

- `rag-checklist/README.md` — explains the split model:
  - **RAG-Retrieval subset:** §1 Chunking, §2 Hybrid Search, §3 Reranking,
    §4 Context Window, §8 HNSW, §9 Semantic Cache. Applies to query-driven
    apps (chatbot, job-strategist) and the relevant pipeline producers
    (ingestion: §1/§2/§8).
  - **LLM-Safety subset:** §5 PII + toxicity, §6 Grounding/self-correction,
    §7 Zero-result handling. Applies to every app that calls an LLM,
    pipeline or query.
- One file per app: `chatbot.md`, `job-strategist.md`, `ingestion.md`,
  `resume-import.md`, `article-pipeline.md`. Each contains only the applicable
  checklist items, every item rendered as a real `- [ ]` checkbox with three
  sub-bullets carried from the audit: **Status** (IMPLEMENTED / PARTIAL /
  MISSING / N-A), **Evidence** (`file:line`), **Gap**. Non-applicable items
  are listed in a short "Not applicable" section with the one-line reason.

## B. GitHub Issues

Two issues opened with `gh issue create`, labels `shared`, `security`:

1. **shared PII scrubber module** — body: motivation (4/5 apps leak PII to
   LLM/DB/logs), the `IPiiDetector` design, and a per-app acceptance checklist
   (one box per app: "PII scrubbed before LLM call, before DB write, before
   log emission").
2. **shared grounding verifier module** — body: motivation (grounding is
   prompt-only everywhere, no backward verification), the `IGroundingVerifier`
   design, per-app acceptance checklist with the chosen mode (query apps:
   `block`; pipeline apps: `flag`).

Issues represent sub-project 2 work; sub-project 1 only opens them.

## C. Shared PII Scrubber Module

Location: `applications/shared/src/security/` (extends existing module; barrel
export from `security/index.ts`).

### Design rationale

The existing `InputSanitiser` already accepts `piiPatterns` but only **warns**
— it never redacts, and patterns must be supplied by each consumer. PII also
leaks at sinks `InputSanitiser` never sees: DB writes and log lines (acute in
resume-import and ingestion). So the scrubber is a standalone redactor, not an
addition to the input flow. It mirrors the storage-agnostic `IReranker`
interface pattern already established in `retrieval/`.

### Components

- **`IPiiDetector`** (interface): `detect(text: string): PiiSpan[]` where
  `PiiSpan = { start: number; end: number; type: PiiType; value: string }`.
  `PiiType` enum: `EMAIL | PHONE | SSN | CREDIT_CARD | IP | NAME`.
- **`RegexPiiDetector`** (default impl): regex set for email, phone, SSN,
  credit-card (Luhn-shaped), IPv4, and a conservative name heuristic
  (capitalised bigram near name-context keywords — deliberately low-recall to
  avoid over-redaction; documented as best-effort).
- **`ComprehendPiiDetector`** (stub): implements `IPiiDetector`, throws
  `NotImplementedError` with a pointer to the GitHub issue. Exists so apps can
  swap detectors later without rewiring. Not implemented this sub-project.
- **`PiiScrubber`** (class): constructor takes
  `{ detector?: IPiiDetector; policy?: RedactionPolicy }` (default detector =
  `RegexPiiDetector`). Method `scrub(text): { redacted: string; spans:
  PiiSpan[]; found: boolean }`. `RedactionPolicy` maps each `PiiType` to a
  mask token (defaults `[EMAIL]`, `[PHONE]`, `[SSN]`, `[CC]`, `[IP]`,
  `[NAME]`). No reversible map (YAGNI — add only when an app needs
  rehydration).

### Testing

Jest unit tests colocated (`security/pii-scrubber.test.ts`): per-type
detection, redaction correctness, span offsets, overlapping matches, empty/no
-PII input, and an adversarial fixture set (obfuscated emails, spaced SSNs,
unicode look-alikes) — checklist §5 explicitly requires adversarial testing.

## D. Shared Grounding Verifier Module

Location: new `applications/shared/src/grounding/` with `index.ts` barrel,
added to the top-level `shared/src/index.ts` export.

### Components

- **`IGroundingVerifier`** (interface): `verify(input: GroundingInput):
  Promise<GroundingResult>` where `GroundingInput = { query: string;
  contextChunks: string[]; answer: string }` and `GroundingResult =
  { status: 'GROUNDED' | 'NOT_GROUNDED'; reason: string;
  ungroundedClaims: string[] }`.
- **`BedrockGroundingVerifier`** (impl): runs the checklist §6 prompt pattern
  on Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) via the existing Bedrock
  runtime client. Parses the model's `GROUNDED | NOT_GROUNDED` verdict,
  reason, and ungrounded-claim list defensively (null-safe, like the existing
  agent response parsers).
- **Mode** (`block | flag`, constructor config — per the approved per-app
  decision): `flag` returns the original answer plus `GroundingResult`
  metadata for the caller to act on; `block` returns the standard
  "I don't know" fallback string when `NOT_GROUNDED`. The module returns a
  discriminated result; it does not itself decide app-level UX beyond
  substituting the fallback in `block` mode.
- **Metrics:** emit EMF via the existing `emf.ts` — `GroundingChecked`
  (count) and `GroundingFailed` (count) so §6's "logged so failure rates can
  be monitored" requirement is satisfied at the shared layer.
- Runs post-generation; interface is `async` so apps can await or fire
  -and-forget in `flag` mode.

### Testing

`grounding/grounding-verifier.test.ts`: a grounded fixture (answer fully
supported by context → `GROUNDED`), a hallucinated fixture (claim absent from
context → `NOT_GROUNDED` with the claim listed), malformed-model-output
parsing, `block` vs `flag` return-shape, and a metric-emission assertion
(mock emf). Bedrock client mocked — no live calls in unit tests.

## Architecture / Data Flow

```
[caller app]
  ── input ──> PiiScrubber.scrub() ──> redacted text ──> (LLM | DB | log)
                                                              │
  generated answer + context + query ──> IGroundingVerifier.verify()
       ├── flag  → {answer, GroundingResult} + EMF metric
       └── block → NOT_GROUNDED ? fallback string : answer  + EMF metric
```

Both modules are pure shared library code with no app coupling — sub-project 2
imports them.

## Scope Guards (YAGNI)

- Build C + D + their tests only. No app imports them this sub-project.
- `ComprehendPiiDetector` is a throwing stub + issue, not an implementation.
- No reversible PII map.
- Semantic cache is sub-project 3, not touched here.

## Success Criteria

- `rag-checklist/` exists with README + 5 per-app files, items as
  checkboxes with Status/Evidence/Gap.
- Two GitHub issues open with per-app acceptance checklists.
- `PiiScrubber` + `IPiiDetector` + `RegexPiiDetector` + `ComprehendPiiDetector`
  stub exported from `@bedrock/shared/security`, all tests green.
- `BedrockGroundingVerifier` + `IGroundingVerifier` exported from
  `@bedrock/shared`, all tests green, EMF metrics emitted.
- `npm test` and `npm run typecheck` pass in `applications/shared`.
```
