# RAG Sub-project 2 — Wire Shared Safety Modules into 5 Apps

**Date:** 2026-05-16
**Status:** Approved (design)
**Author:** Nelson Lamounier (with Claude Code)
**Depends on:** Sub-project 1 (`RAG_Shared_Safety_Design_Review.md`, PR #4 — branch `feat/rag-shared-safety`). Tracking issues: #2 (PII), #3 (grounding).

## Context

Sub-project 1 shipped two reusable `@bedrock/shared` modules — `PiiScrubber`
(redacting, pluggable detector) and `BedrockGroundingVerifier` (checklist §6,
`block`/`flag`) — with tests but **no app wiring**. Sub-project 2 wires them
into the five apps per the per-app acceptance checklists in issues #2/#3.

Decision (brainstormed): **direct wire-in, always-on** (no feature flags).
Chatbot grounding uses **Bedrock Agent trace citations** for context
(chatbot is the only app on the managed Agent; the others use direct
`ConverseCommand`/`runAgent`).

## Goals

Wire both modules into the 5 apps so that:
1. PII is redacted before every sink that can leak it — the LLM call, DB
   writes, and log lines — in chatbot, job-strategist, ingestion,
   resume-import, article-pipeline.
2. Grounding is verified post-generation: chatbot + job-strategist in
   `block` mode (substitute fallback on NOT_GROUNDED); resume-import +
   article-pipeline in `flag` mode (annotate, never block). Ingestion gets
   PII only (no generation step).

Non-goals: ComprehendPiiDetector implementation (still stubbed), semantic
cache (sub-project 3), toxicity filtering (tracked separately).

## Architecture Principles

- **One module-scoped `PiiScrubber` singleton per file.** It is stateless
  and zero-cost (regex). Do not `new PiiScrubber()` at each call site.
- **Grounding runs at the orchestration layer** (Lambda handler /
  `run-pipeline` / `run-import`) where the generated answer and its
  retrieved context coexist post-generation. It is **never** added inside a
  synchronous `parseResponse` (that would force an async ripple through
  `BaseAgent`).
- **Always-on**, no flags. Mode is fixed per app per issue #3.
- **Fail-open for the host pipeline.** A grounding verifier error (Bedrock
  failure) must not fail the host request:
  - `flag` apps: catch → skip annotation, log + emit a failure metric,
    proceed with the original answer.
  - `block` apps (chatbot, job-strategist): catch → return the original
    answer (do NOT hard-fail the user request), log + emit a metric. The
    fail-safe is at the parse layer (ambiguous model output →
    NOT_GROUNDED); an infra error is distinct and must not blank the user.
- PII scrubbing never throws (the default `RegexPiiDetector` is total; the
  Comprehend detector is unused).

## Per-App Integration

References below are the integration points mapped from the codebase
(2026-05-16). Line numbers are starting anchors; the implementer confirms
exact lines at edit time.

### chatbot — PII + grounding(block)
- **PII:** scrub the user prompt before the Bedrock Agent invoke (around
  the existing `InputSanitiser.sanitise()` call in `src/index.ts` ~358–404,
  scrub after injection check, pass redacted text to `invokeChatbotAgent`).
  Scrub `errorMessage` before the agent-error `log()` (~`src/index.ts`
  267–271).
- **Grounding (block):** in `src/agents/chatbot-agent.ts` set
  `enableTrace: true` on `InvokeAgentCommand` (~81–92); while consuming
  `response.completion`, collect `chunk.attribution.citations[]
  .retrievedReferences[].content.text` into a `contextChunks` array and
  return it alongside the answer. In `src/index.ts` between `stripCodeFence`
  (~412) and `outputSanitiser` (~413), call the verifier (mode `block`)
  with `{ query: userPrompt, contextChunks, answer: normalised }`; use
  `result.answer` for output. If `contextChunks` is empty (no citations),
  skip verify and proceed (log a metric) — do not fabricate grounding.

### job-strategist — PII(redact) + grounding(block)
- **PII:** `src/agents/research-agent.ts` currently uses warn-only
  `InputSanitiser` + ad-hoc `STRATEGIST_PII_PATTERNS` (~40–54). Keep
  injection/length handling; add a module-scoped `PiiScrubber` and redact
  the JD after `sanitiseWithWarnings` (~366) before it is used in vector
  queries (~388–394) and the Bedrock message (~416). Redact the
  query-preview log field (~125–131). Apply scrub to output alongside
  `OutputSanitiser`.
- **Grounding (block):** at the pipeline layer in `run-pipeline.ts` (after
  the strategist agent returns, before persisting/returning) — NOT inside
  `strategist-agent.ts parseResponse`. Context = the deduped research KB
  context already passed to the strategist; answer = strategist analysis.
  On NOT_GROUNDED substitute the fallback before persistence/return.

### ingestion — PII only
- Scrub all user-controlled strings (README, manifests, changelog,
  workflows, commit messages) at the return of
  `src/agents/ProfileInputCollector.collect()` so every downstream consumer
  (Bedrock extraction prompt, persistence) sees redacted text.
- Defence-in-depth: scrub `content` before the vector insert in
  `src/repositories/RepositoryProfileEmbeddingsRepository.upsertBatch()`
  (use the scrubbed content for the hash too, so the hash stays stable).
- Scrub error messages before `console.warn`/status-sync writes
  (`ProfileInputCollector` ~78/124, `run-ingestion.ts` ~304).

### resume-import — PII(critical) + grounding(flag)
- **PII sinks:** scrub resume text in `src/bedrock/extract-career.ts`
  before the Bedrock body (~225, scrub then slice); scrub
  title+company in `src/bedrock/enrich-role.ts` Tavily query build (~92)
  and the Tavily-cache `query_text` write (`src/tools/tavily-cache.ts`
  ~64–77, scrub before key/normalise so the cache key stays deterministic);
  scrub highlights at chunk-build in `src/embed.ts` (~70–76, so
  `content_hash` is stable); scrub `error_details` JSON before DB writes
  (`run-import.ts` ~133–136 and ~395–403; `run-enrichment.ts` ~203–206);
  scrub `query`/`title` in `enrich-role.ts` logs (~108–118, ~162).
- **Grounding (flag):** in `src/bedrock/gap-analysis.ts` after the
  generation call(s) return, per role verify the suggested additions
  (`answer`) against source bullets + public/Tavily context
  (`contextChunks`); collect `GroundingResult[]`. Attach as
  `groundingMetadata` inside the existing `gap_report` JSON payload in
  `run-import.ts` (~363–370) — **no schema migration** (wrap the report:
  `{ report, groundingMetadata, verifiedAt }`).

### article-pipeline — PII + grounding(flag)
- **PII:** scrub `draftContent` immediately after `readDraftFromS3()` in
  `src/agents/research-agent.ts` (~483–484); scrub `writer.data.content`
  before `persistArticle()` in `run-pipeline.ts` (~94); redact/suppress
  query and author-direction log fields (~196, ~301); scrub the catch-block
  error message (~107–113).
- **Grounding (flag):** in `run-pipeline.ts` between QA completion and
  persist (~85–94), verify `{ query: draft excerpt, contextChunks:
  research.kbPassages.map(p => p.text), answer: writer.data.content }`;
  emit EMF (`GroundingChecked`/`GroundingFailed`/`UngroundedClaimCount`)
  and attach grounding metadata to the pipeline-run record via the existing
  `updatePipelineRun` JSON (no migration preferred).

## Data / Control Flow (uniform)

```
raw input ──PiiScrubber.scrub──► redacted ──► LLM / DB / log
generated answer + retrieved context
   └─ orchestration layer ─► BedrockGroundingVerifier.verify(mode)
        block → NOT_GROUNDED ? fallback : answer  (chatbot, job-strategist)
        flag  → original answer + groundingMetadata persisted (resume-import, article-pipeline)
   verifier infra error ─► catch → original answer + failure metric (never hard-fail host)
```

## Testing

Per app, add/extend tests (mock Bedrock/DB/Tavily, no live calls):
- PII: assert the text reaching the mocked LLM/DB/log sink is redacted
  (contains mask tokens, not the original PII) at each identified sink.
- Grounding: assert the verifier is called with the correct
  `contextChunks` + `answer`; assert `block` substitutes the fallback on a
  mocked NOT_GROUNDED and passes through on GROUNDED; assert `flag` never
  changes the answer and attaches `groundingMetadata`; assert a mocked
  verifier error does not fail the host path.

## Scope / Sequencing

One spec; the implementation plan sequences **per app** (5 independent
units), executed subagent-driven, each app = its own task(s) + tests +
atomic commit(s). Branch off `feat/rag-shared-safety` (sub-project 1 not yet
merged — the shared modules must be present). If a grounding-metadata column
is unavoidable for an app, it is an idempotent `IF NOT EXISTS` migration
following the repo convention (commit `d658762`); JSON-payload attach is
preferred to avoid migrations.

## Success Criteria

- All five apps import and invoke the shared modules at every sink/point in
  the matrix above; no app sends unredacted PII to an LLM/DB/log.
- chatbot + job-strategist substitute the fallback on NOT_GROUNDED;
  resume-import + article-pipeline attach grounding metadata and never
  block.
- Verifier infra errors never hard-fail a host request.
- Each app's existing test suite plus the new wiring tests pass; affected
  apps `typecheck` clean. Issues #2 and #3 per-app acceptance boxes tickable.
