# Projects / case-study pipeline — design review (2026-07-07)

> **Status:** Actionable review. Grounded in the code as of develop
> (post enrichment-retirement, post #423) and in the live dev database
> — the `frontend-portfolio` project (id `7ca4da40-b895-4c6b-a211-40702b3ad19c`)
> serves as the measured baseline for the planned A/B regenerate.
>
> **TL;DR:** output quality and the output contract are genuinely good —
> the recruiter framing, per-row evidence citation (`sourceSignals`) and
> JSON robustness are above industry norm. The problems are on the
> **input side** (what feeds the LLM and in what order) and the **cost
> side** (103K-token prompts, zero caching, growing on every
> regenerate). The live project cost $2.75 across 5 generations and
> each regenerate got MORE expensive (84K → 131K input tokens).

---

## 1. Live baseline (frozen for the A/B regenerate)

| Dimension | Value |
|---|---|
| Project | `frontend-portfolio`, side_project / single_repo, archetype `production_saas` |
| Case study | complete, generated 2026-07-05 08:08, `eu.anthropic.claude-sonnet-4-6` |
| Narrative artefacts | pitch 2,290 chars (product-first, strong differentiator close), 5 challenges / 5 decisions / 5 highlights / 1 component; highlights carry verified numbers (LCP 132 ms) |
| `product_description` | **empty** — the authoritative product-statement override has never been populated |
| Generation cost | `project-case-study`: 5 calls, 516K input / 80K output tokens, **$2.75**; `project-system-tour`: 5 calls, $0.53 |
| Cost trend | input tokens per call: 84K → 84K → 96K → 121K → **131K** (refine mode appends the prior study; commits accumulate) |
| Prompt caching | `cache_tokens_saved: 0` on all 10 invocations — no caching of any kind fired |

---

## 2. What data is passed to the LLM (prompt assembly, in order)

Case-study call: Sonnet 4.6, forced `emit_case_study` tool, maxTokens
32,768, thinking 0, context budget ~120K est. tokens
(`case-study-agent.ts` / `case-study-loader.ts` /
`case-study-context-budget.ts`).

| # | Prompt block | Source | Cap |
|---|---|---|---|
| 1 | `<project>` envelope (name, tagline, pitch, components, repositories, commits, pulls) | `projects`, `project_components`, `project_repositories` → `repositories` + `repository_profiles.extracted->tech_stack`, **all `repo_commits`** (newest first, no SQL limit), **all `repo_pull_requests`** | ingestion stores ≤500 commits / ≤100 PRs per repo; then the token packer |
| 2 | `<productContext>` | `projects.product_description` override → else GitHub description + head of root README (from `document_embeddings` README rows) | 1,400 chars/repo, 4,000 global |
| 3 | `<kbChunks>` | `document_embeddings` — **24 chunks by `last_synced_at DESC`** | pure recency; no similarity, no fileClass/docs preference; 2,400 chars/chunk |
| 4 | `<fileChanges>` | `repo_commit_files` churn, top 30 files | 30 |
| 5 | `<verifiedStack>` | `technology_evidence` JOIN `technology_ontology` (syft/treesitter/iac/dockerfile layers) | 80, version-bearing first |
| 6–7 | `<priorCaseStudy>` + `<newRepos>` (refine runs only) | prior persisted rows incl. stored `source_signals` | none |

Token packing is greedy in the order **commits → kbChunks → pulls**
(commit messages truncated at 800 chars, chunks 2,400, PR bodies
1,200). Consequence: **PRs — which the system prompt itself calls the
strongest form of evidence — are the first thing silently dropped** on
commit-heavy projects.

The system prompt opens (verbatim): *“You are a portfolio editor
writing the case study for a single project… Your output is read by
recruiters and engineers; treat every claim as something the author may
be asked about in an interview.”* Optional appendices: archetype
calibration (“This is a {stage}-level {archetype} project…”) and the
REFINE block.

---

## 3. Answers to the review questions

### Is the pipeline taking full advantage of the ingested data (post-enrichment)?

**Enrichment: chunk `skills[]`, the Tier-1 map and `file_tech_stack`
are never read by the projects pipeline — the enrichment retirement
changed nothing here.** The real ingestion→projects connections are:
`technology_evidence` (verified stack, used in the prompt AND for
persist-time stamping), `archetype_signals` (prompt calibration +
deterministic depth markers), fileClass lane counts (depth markers),
and raw README/chunk content.

Beyond that, **meaningful data goes unused**: `evidence_topology`,
`repository_profiles` classification/quality fields, `dsa_evidence`,
and — most importantly — the docs corpus: the 24-chunk window is
recency-arbitrary, so whether `docs/concepts/*` files (prime
case-study material) enter the prompt depends on sync timing, not
relevance. **PR review comments are not ingested at all** — the
collaboration-evidence lane is missing for a recruiter narrative.

### Is the design cost-optimised?

**No — this is the biggest available win.**

- No Bedrock prompt caching anywhere (`cache_tokens_saved: 0` across the board).
- Refine mode (default after the first generation) **bypasses the semantic cache** — every regenerate is a full-price Sonnet call.
- Input grows per regenerate (prior study appended; commits accumulate).
- The system-tour Sonnet call is re-paid on every run — `runSystemTour` supports a cache, but `run-case-study.ts` never passes one; a case-study cache HIT still pays a full tour call.
- The semantic-cache key omits `kbChunks` content, `fileChanges` and `verifiedStack` — stale-serve risk one way, and the agent’s own tagline/pitch output feeds back into next run’s hash the other way.
- `verifiedStack` is loaded twice per run with near-identical SQL (loader + persistence).

### Can the LLM response be cut?

Yes, meaningfully:

- **`depthMarkers`** is a required schema field the model must generate — and the orchestrator **discards it** (deterministic override from fileClass lanes + archetype signals). Remove from the schema.
- **`architecture.nodes/edges` duplicates `diagramSource`** — keep one.
- **`resumeBullets`** (up to 6 angles × 8 bullets × 500 chars) dominates the ~16–18K output tokens. Generate only angles relevant to the project archetype / user target roles, or on demand.
- Rule/schema mismatch: prompt says bullets ≤250 chars, schema allows 500.

Realistic post-fix regenerate: **~$0.20–0.25 instead of $0.65 and climbing.**

### Is the LLM response well-formatted (JSON)?

**Yes — the strongest part of the design.** Forced tool_use → Zod
validation → two deterministic repairs (`coerceArchitectureString`,
`clampOversizedFields`) → one bounded model retry that feeds the exact
Zod issues back. Persistence is transactional and idempotent
(`(project_id, content_hash)` insert-then-prune; user-confirmed rows
and `user_overrides` sticky sections preserved).

### Right data for a recruiter-facing description? Narrative well-established?

The framing is explicitly recruiter-first and it demonstrably lands
(see baseline pitch/highlights). Voice rules enforce candidate voice
and confident phrasing; highlights must be “things a recruiter could
point to in 5 seconds”.

Two weaknesses:

1. **The narrative graders never run in production.** `taglineIsProductFirst`, `pitchOpensWithProduct`, `workLeadsNarrative`, `confidentVoice` and the combined-overview LLM judge exist — but only in eval scripts. A framing regression ships ungated.
2. **Grounding is citation-presence only.** A row is GROUNDED iff it cites any commit/PR/file; nothing verifies a cited SHA/PR exists in the supplied evidence (regex only). The old per-row LLM verifier was removed for noise (~15 Haiku calls/run, ~100% false NOT_GROUNDED); a deterministic set-lookup against the supplied context would be nearly free.

Also: populate `product_description` — it takes precedence over
README-derived product context and is currently empty.

### Does the JD / job-strategist flow get what it needs from projects?

Projects feed the JD pipeline at **eight join points**: research-agent
grounding block (“Project Case Studies — Documented Portfolio
Projects”), strategist “CITEABLE EVIDENCE” block, achievement evidence
(cover letter), resume-guard pitches, cover-letter guard, free-tier
writer, and two coach stages (system-design walkthrough, bar-raiser).

Gaps: the **achievement-evidence loader is unranked and user-global**
(`ORDER BY order_index LIMIT 4` across ALL projects — the cover letter
can lead with a challenge from the least relevant project), and the
**system tour has no verified downstream consumer** (not the coach; UI
consumer unconfirmed) — potentially pure cost.

### Industry standard?

Above standard: schema-forced output with repair-retry; per-row
`sourceSignals` provenance; idempotent reconciling persistence; refine
mode with coverage guarantees. Below standard: no prompt caching on a
100K+ prompt; relevance-blind (recency) context selection — the
strategist side of the same codebase does similarity + rerank properly;
quality gates that exist but do not gate.

---

## 4. Improvement plan

### P1 — cost & sourcing (do BEFORE the A/B regenerate so it measures them)

> **STATUS: SHIPPED 2026-07-07** — all four items merged to develop in
> [PR #425](https://github.com/Nelson-Lamounier/ai-applications/pull/425)
> (merge commit `1877246`, image live in SSM/ESO). Notes: the tour skip
> (item 4) landed as cache-through keyed on hash(caseStudy) rather than an
> explicit skip — same saving, self-heals a missing tour row. The Zod gate
> deliberately still accepts depthMarkers / 6 sets / 500-char bullets so
> pre-trim cached artefacts keep validating. Ready for the A/B regenerate.

1. **Reorder the token packer: PRs → docs-lane chunks → commits**, and cap commits (~150 newest). Commit messages are the current bloat king (up to 500 × 800 chars/repo).
2. **Replace 24-recency chunks with docs-lane-preferred, similarity-selected chunks** (query = project pitch/tagline; retrieval machinery already exists in shared).
3. **Drop `depthMarkers` from the tool schema** (discarded anyway); trim `resumeBullets` to archetype-relevant angles.
4. **Wire the existing system-tour cache** and skip the tour on case-study cache hits.

### P2 — quality gates

5. **Deterministic citation-existence check**: cited SHAs / PR numbers / file paths must exist in the supplied evidence (set lookup). Fail → downgrade grounding, optionally one retry.
6. **Promote the deterministic graders** (product-first, confident-voice, work-leads-narrative) to a production gate with one bounded retry.
7. **Rank achievement-evidence** by target project relevance instead of unscoped `order_index`.

### P3 — hygiene

8. Add `kbChunks`/`fileChanges`/`verifiedStack` to the semantic-cache key; stop hashing the agent’s own prior tagline/pitch output as input.
9. Fix the 250/500 bullet-length rule/schema mismatch.
10. Delete or wire `change-impact-narrator` (currently dead code with no production caller).
11. Correct stale comments/docs: `MAX_COMMITS 50` / `MAX_PULLS_PER_REPO 25` (nonexistent caps), “regeneration accumulates rows” (persistence now prunes), grounding-verifier references in `case-study-generation.md`.
12. Deduplicate the verified-stack SQL (loader vs persistence).

---

## 5. A/B protocol for frontend-portfolio

Baseline (above) is frozen. Apply P1, regenerate via the UI CTA, then compare:

- **Cost**: `prompt_invocations` for the project — input/output tokens + USD vs $0.65/131K.
- **Sourcing**: whether the new `docs/concepts` content enters `<kbChunks>` by relevance (P1.2) rather than sync-timing luck.
- **Content**: pitch/highlights/decisions diff — expect equal-or-better narrative with PR evidence visibly cited in `sourceSignals`.
- **Regression guard**: the deterministic graders (P2.6) green on the new artefact.
