# AI-Augmented Engineering Pillar — S4: evidence lane + detector — Design

> **Date:** 2026-06-02
> **Status:** Approved design (brainstorming complete). Plan next.
> **Goal:** Surface the *rare, real* AI-engineering practice artifacts in a user's repos (prompt caching, MCP integration, grounding/verification, eval harnesses, cost engineering) as honest evidence — the differentiated 2026-hiring signal nobody else surfaces.
> **Repo:** `ai-applications` (lane + detector only; the AI workspace section is a deliberate follow-up, post-FP-audit).
> **Design input:** `docs/superpowers/specs/2026-06-02-devops-ai-pillars-design-input.md` §3b/§4/§10.
> **Fourth sub-project** (S4). Clones the DSA real-work detector lane (migrations 054/055, `DsaPatternExtractor`, `dsa-evidence.ts`).
> **Build base:** branch off `develop` AFTER #119 (DSA detector re-land) + #118 (S2) merge, so it mirrors the per-lane idempotency in `run-tech-extract` and adds AI as a third lane without conflict.

## Why this is the most differentiated pillar

AI-engineering artifacts live in repos but are invisible to today's KB (indexed as TS/markdown, not detected as AI signals). Unlike DevOps (already extracted) and DSA (off-GitHub), these are *new* extraction of *unusually honest* artifacts — a `cachePoint` payload key, a `@modelcontextprotocol/sdk` tools call, an `evals.json` schema are authored constructs, not behavioral inference.

## Hard constraints (carried)

1. **Call-site/body-anchored, never presence/path/import-only.** A `prompts/` folder, a lockfile dependency on the MCP SDK, a class *named* "grounding" with an empty body — all NEC-NOT-SUFF → excluded. Every signal requires an authored construct a human can confirm at file:line.
2. **Lane-ownership contract (ratified).** tech-extract owns "uses X technology"; `ai_evidence` owns "built X capability". The AI lane MUST NOT emit artifacts the tech lane already extracts — specifically NOT `aws_bedrock` (already emitted from `BedrockRuntimeClient` via sdkCallPatterns) and NOT `pgvector`-as-technology. AI signals are higher-order *practice* constructs only.
3. **FP ≤ 5% hand-inspection gate** before any AI evidence surfaces in the UI (the AI workspace section is out of scope here and gated on this audit).

## The 5 detectors (generic, call-site/body-anchored)

| # | Signal → canonical | Anchor (sufficient) | Conf |
|---|---|---|---|
| 1 | prompt caching → `ai_prompt_caching` | `cachePoint` key inside a request/message payload (object literal key, not a comment) | 0.78 |
| 2 | MCP integration → `ai_mcp_integration` | `@modelcontextprotocol/sdk` import (source, not lockfile) **AND** a call-site: `tools/list`/`tools/call`/`.listTools(`/`.callTool(`/`CallToolRequest`/`server.tool(` | 0.80 |
| 3 | grounding/verification → `ai_grounding` | a `class`/`interface` whose name matches `/Grounding\|Verifier\|Hallucination/` **AND** its body references `source`/`context`/`citation`/`grounded` (excludes empty stubs) | 0.70 |
| 4 | eval harness → `ai_eval_quality` | a file matching `eval(s)?.*\.json` or under `evals/` whose parsed content is an array of objects each having `prompt` **and** one of `expected`/`expected_output`/`ideal`/`reference`, with ≥3 entries | 0.75 |
| 5 | cost engineering → `ai_cost_engineering` | a call-site referencing an LLM usage/token field (`inputTokens`/`input_tokens`/`promptTokens`/`usage`) **together with** a price/cost computation or a cost-record write (same statement/function) | 0.70 |

**Explicitly NOT detected** (the design-input drops): Bedrock/LLM-integration (already in tech lane — lane-ownership); `prompts/` or `.claude/skills/*/SKILL.md` by path (scaffolded/boilerplate); `@modelcontextprotocol/sdk` in `package.json` only; the word "grounding" in prose; a bare `evals.json` that doesn't match the schema; `/agents/` dir as "orchestration"; `thinkingBudget` (JSDoc only); `.claude/settings.local.json` (gitignored).

## Components (all `ai-applications`, single PR)

### A. `057_ai_topics.sql` (mirrors `051_dsa_topics`)
Global, no RLS, idempotent, constraint-only. Seed ~12 canonicals: `ai_llm_integration`, `ai_prompt_engineering`, `ai_prompt_caching`, `ai_mcp_integration`, `ai_agent_orchestration`, `ai_grounding`, `ai_eval_quality`, `ai_cost_engineering`, `ai_observability`, `ai_safety_security`, `ai_rag_retrieval`, `ai_embeddings` — each with display_name, category, jd_signal_keywords (for future calibration), source, as_of. The detector emits 5 (#1–#5 canonicals above); the rest seed the catalog.

### B. `058_ai_evidence.sql` (mirrors `054_dsa_evidence`)
```sql
CREATE TABLE ai_evidence (
  id UUID PK DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL, commit_sha TEXT NOT NULL,
  ai_topic TEXT NOT NULL REFERENCES ai_topics(canonical_name),
  signal TEXT NOT NULL, raw_name TEXT NOT NULL,
  file_path TEXT NOT NULL, line_start INT NOT NULL, confidence REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, repo_full_name, commit_sha, ai_topic, file_path, line_start)
);
-- RLS enable + policy USING (user_id = current_setting('app.current_user_id', true)::uuid)
-- index (user_id, repo_full_name)
```

### C. `059_ai_scanned_commits.sql` (mirrors `055`)
PK (user_id, repo_full_name, commit_sha), match_count INT, scanned_at; RLS. Idempotency marker (records "scanned" even at 0 matches → no re-download on re-sync).

### D. `shared/src/stage-prep/ai-evidence.ts` (mirrors `dsa-evidence.ts`)
`AiTopicResolver` (constructed from the valid `ai_topics.canonical_name` set; `resolve()` drops unknown — never invents). `RdsAiEvidenceRepository`: `insertMany`, `hasAiScanForCommit`, `recordAiScan`, `listForRepo` (RLS-scoped via `set_config('app.current_user_id')`, mirroring the DSA repo). Export from the stage-prep barrel. (`RdsAiTopicRepository` in `ai-topics.ts` optional — the resolver only needs `listCanonicalNames()`; add a minimal loader.)

### E. `tech-extractor/src/extractors/AiPatternExtractor.ts` (mirrors `DsaPatternExtractor`)
Own type `RawAiEvidence { raw_name, topic_hint, signal, confidence, file_path, line_start }`; pure `detectAiPatterns(src, lang, filePath)` dispatching the 5 detectors (TS/JS/Python where relevant); `class AiPatternExtractor(readFile, files)`. Inline-string fixture tests: positive per signal + the do-NOT-detect negatives (path-only, lockfile-only, stub class, prose, bare evals.json).

### F. `run-tech-extract.ts` wiring (third lane)
After the DSA lane block (from #119), add an AI lane block: `aiDone = !!commitSha && await aiRepo.hasAiScanForCommit(...)`; include `aiDone` in the full short-circuit (`techDone && dsaDone && aiDone`); when `!aiDone`, run `AiPatternExtractor` → `AiTopicResolver.resolve` (drop unresolved) → `RdsAiEvidenceRepository.insertMany` → `recordAiScan`. **Fail-open** (its own try/catch; never breaks tech-extract).

### G. `ai-fp-audit.ts` (mirrors `dsa-fp-audit`)
Dev CLI: run `detectAiPatterns` over given repo dirs, print `repo,file:line,signal,raw_name,confidence` CSV + total. Merge gate: ≥5 real repos, hand-inspect, FP ≤ 5%; drop the weakest signal (grounding or cost, both 0.70) first if exceeded.

## Data flow
```
run-tech-extract (existing job): discover files
  → [tech lane] technology_evidence       (unchanged)
  → [DSA lane]  dsa_evidence               (#119)
  → [AI lane — NEW] AiPatternExtractor → AiTopicResolver (drop unknown) → ai_evidence (RLS)
(future spec) admin-api serves ai_evidence → AI workspace section 🟢 (gated on FP-audit)
```

## Error handling & honesty guardrails
- `topic_hint` not in `ai_topics` → dropped (resolver), never invented.
- Every row has file:line → UI deep-link / human confirmation.
- Per-signal confidence stored verbatim; nothing claims certainty.
- Lane-ownership: AI lane never emits a tech-lane artifact (no `aws_bedrock`, no `pgvector`-as-tech).
- AI extraction fail-open + own scan-marker idempotency.
- Negative tests enforce the do-NOT-detect list.

## Testing
- **B/C (migrations):** apply; `ai_evidence` FK to `ai_topics`; RLS on; marker upsert.
- **D (resolver/repo):** resolve known/unknown; insertMany user-scoped; hasAiScanForCommit/recordAiScan round-trip (fakePool).
- **E (detectors):** each of the 5 → positive inline fixtures (right topic_hint + confidence + line); negatives (path-only, lockfile-only MCP, stub grounding class, prose "grounding", bare/non-schema evals.json) → emit nothing; lang dispatch.
- **F (wiring):** AI evidence persisted after a run; an AiPatternExtractor throw does not fail the job; aiDone short-circuit.
- **G (audit):** runs over a fixture dir, prints CSV + total.

## Decomposition
Single PR (`ai-applications`): migrations 057/058/059 + `ai-evidence.ts` (+ minimal `ai-topics.ts`) + `AiPatternExtractor` + `run-tech-extract` AI lane + `ai-fp-audit` + tests. (Mirrors DSA #116 as one PR.)

## Out of scope (S4)
- AI workspace section / 🟢 cards + admin-api `aiEvidence` serve (follow-up spec, gated on FP-audit).
- JD AI-topic calibration (future; extends the `dsaTopicCalibration`/pillar pattern).
- The 7 seeded-but-undetected topics (catalog only until honest detectors exist).
- Practice-problem generation, tutoring, etc. (never).
