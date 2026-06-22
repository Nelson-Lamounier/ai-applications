# Free-Tier Cost Recording + Narrative Uplift

- **Date:** 2026-06-22
- **Status:** Design approved, awaiting spec review
- **Owner:** Nelson Lamounier
- **Repo:** ai-applications / job-strategist
- **Relates to:** the free-tier resume engine (PR #326, merged)

## Problem

Two gaps surfaced from the first live free-vs-paid A/B run:

1. **No cost visibility.** `runAgent` accumulates per-call cost into the pipeline
   context (`ctx.cumulativeCostUsd`/`cumulativeTokens`), but **neither the free
   nor the paid strategist run persists it** to `pipeline_runs.metadata` (only the
   case-study pipeline does). The free path is worse: the JD extractor uses a
   throwaway context, so even in-memory its cost is lost. We cannot answer "what
   does a free run cost vs a paid run?".

2. **Free narrative under-positions.** Paid reads "tighter + positioning" because
   of LLM-driven stages (archetype selection, the matcher's verified/partial/gap
   framing) the free tier deliberately drops. But two **high-value inputs that are
   pure DB reads** are unused by the resume pipeline entirely:
   - **GitHub commits/PRs** — `repo_commits` (2,671 for the test user) and
     `repo_pull_requests` (674), with conventional-commit, impact-describing titles
     that read like ready-made resume bullets.
   - **Profile-intelligence** — `user_profile_rollup.direction` holds
     code-grounded per-area **seniority** with evidence (e.g. senior in "Platform
     & Kubernetes Engineering" and "Cloud Infrastructure (AWS)").

   Feeding these to the free writer + a sharper persona closes much of the gap
   **without any new LLM call**.

## Goals

- **Stream A:** persist per-run LLM **cost + tokens** to `pipeline_runs.metadata`
  for **both** free and paid runs, so the two are $-comparable.
- **Stream B:** raise free narrative quality toward paid — tighter, positioning-led,
  and grounded in the candidate's real commits/PRs — using only **cheap DB reads
  and prompt changes (no new LLM calls)**.

## Non-goals

- Metering **Titan embeddings + Bedrock rerank** cost (they are unmetered today;
  small relative to the Sonnet writer). Flagged as a separate follow-up; the
  recorded figure is **LLM-agent cost** (extraction + writer [+ grounding]).
- Replicating paid's **archetype selection** or **verified/partial/gap** framing in
  free — both are LLM-driven and excluded under "no new charges".
- Any change to the free tier's data diet beyond the two additive inputs (no
  skill-evidence ledger, no matcher).
- The admin-api A/B gate (already shipped).

## Verified data (queried for the test user, not assumed)

| Source | Volume | Used by free writer today |
|---|---|---|
| `document_embeddings` (RAG/KB) | 12,420 chunks (md 5,842 / ts+tsx 5,436 / yaml 731 / sql 150 / commit-prose 86) | yes |
| `repo_commits` | 2,671 (4 repos) | **no** |
| `repo_pull_requests` | 674 (4 repos) | **no** |
| `technology_evidence` | 17,354 | yes |
| `user_profile_rollup` | populated, fresh; `direction.seniority` = per-area level + evidence | **no** |
| project case study / career | 1 project (5 highlights) / 19 career entries | yes |

## Stream A — Cost recording

### A1. Thread one shared context through the free path
`extractJdSignal` (`agents/jd-extractor.ts`) currently builds its own ephemeral
`BasePipelineContext` (cost discarded). Add an **optional** `ctx?: BasePipelineContext`
parameter; when supplied, use it (so its cost accumulates into the caller's
context); when omitted, keep today's ephemeral behaviour (back-compat).

In `free/run-free.ts`, create the single run `ctx` (already done for the writer)
**before** extraction and pass it to `extractJdSignal(jobDescription, ctx)` and the
writer and the grounding verifier. Result: `ctx.cumulativeCostUsd` /
`cumulativeTokens` hold the full free-path LLM cost.

### A2. Persist cost in both pipelines
- **Free** (`run-free.ts` `buildFreeMetadata`): add `tokens: ctx.cumulativeTokens`
  and `costUsd: ctx.cumulativeCostUsd` to the metadata written via
  `updatePipelineRunMetadata`.
- **Paid** (`run-pipeline.ts`): the run's `ctx` already accumulates across the
  research + strategist agents; at the final `updatePipelineRunMetadata`, add the
  same `tokens` + `costUsd` fields. Pass the same run `ctx` into `extractJdSignal`
  there too, so paid's extraction cost is captured.
- **Shape:** mirror the case-study pipeline exactly — `metadata.tokens =
  { input, output, thinking }`, `metadata.costUsd = <number>` — so existing
  queries/UI read both pipelines uniformly.

### A3. Honest gap note
The persisted `costUsd` excludes embeddings + rerank (unmetered). Document this in
the code comment so the figure is not mistaken for total infra cost.

## Stream B — Narrative uplift (DB reads + persona only)

### B1. Add commit/PR evidence to `FreeEvidence`
New field `commitPrEvidence: string`. A new loader (`free/commit-pr-evidence.ts`)
reads `repo_commits` + `repo_pull_requests` for the user (RLS-scoped), caps to a
small top-N per repo (recent merged PRs first; notable commits), and formats a
compact block, e.g.:

```
Shipped work (from the candidate's own commits & pull requests):
- <repo>: PR "feat(enrichment): content-hash dedup cache — skip Haiku for unchanged chunks" (#NNN)
- <repo>: PR "feat(ingestion): raise pod deadline 15->30 min so big repos finish in one pass" (#NNN)
- <repo>: commit "<message>"
```

Only include rows the candidate **authored** (`author_login` matches the user's
GitHub login where available) so the writer can claim them in first person.
Pure DB read; fail-open to `''`.

### B2. Add profile-intelligence to `FreeEvidence`
New field `profileIntelligence: string`. Read `user_profile_rollup.direction`
(seniority array: `{area, level, evidence}`) via the existing rollup repository,
format the strongest areas into a compact positioning block, e.g.:

```
Positioning signal (code-grounded seniority):
- Platform & Kubernetes Engineering: senior — <evidence>
- Cloud Infrastructure (AWS): senior — <evidence>
```

Pure DB read; fail-open to `''` (so users without a rollup degrade gracefully).

### B3. Wire both into the writer envelope
`free-resume-writer.ts` `buildUserMessage` adds `<commit_pr_evidence>` and
`<positioning_signal>` blocks to the `<evidence>` section. No output-schema change.

### B4. Sharpen the free persona (`prompts/free-resume-persona.ts`)
Prompt-only changes:
- **Lead with positioning.** Open the summary with one positioning line naming the
  candidate's strongest role identity for THIS JD, anchored in the
  `<positioning_signal>` seniority + the JD's `companyProblem`. Tighter than today's
  longer summary (paid-like concision).
- **Prefer shipped work.** When `<commit_pr_evidence>` supports a bullet, ground it
  in the concrete PR/commit and name the work (e.g. "shipped X — PR #NNN").
- Keep the existing impact-bullet contract + the hard anti-hallunation rule
  (numbers/employers/skills only when evidence supports them; commits/PRs are
  citable evidence, profile-intelligence is a positioning aid, not a fact source
  for fabricated metrics).

### B5. Eval (per CLAUDE.md §5)
Extend `free-resume-writer.eval.test.ts` / `gradeFreeResume`:
- **Uses shipped work**: when commit/PR evidence is supplied, at least one
  experience highlight references it (a PR/commit-derived phrase appears).
- **Positioning present**: the summary opens with a positioning line (non-empty,
  references a role/seniority term from the positioning signal).
- **Still no fabrication**: existing employer/metric/skill grounding holds;
  positioning-signal text does not license fabricated metrics.
- A good fixture (with commit/PR + positioning evidence) passes all; bad fixtures
  fail their target check.

## Architecture / data flow (free path, updated)

```
JD text
  ▼  extractJdSignal(jobDescription, ctx)         ← cost now accrues to shared ctx
JdSignal
  ▼  gatherFreeEvidence:
       RAG (hybrid+rerank+citations) · project · extracted tech · career/education
       + commitPrEvidence   (NEW — repo_commits/repo_pull_requests, DB read)
       + profileIntelligence (NEW — user_profile_rollup.direction, DB read)
  ▼  free-resume-writer.invoke(input, ctx)        ← positioning-led, commit/PR-grounded
{ resume, coverLetter }
  ▼  grounded ATS coverage · cover-letter guard · grounding verifier(ctx)
  ▼  persistTailoredResume + updatePipelineRunMetadata({ ..., tokens, costUsd })  ← NEW cost
```

## Error handling

- Both new loaders are **fail-open to `''`** (empty repo_commits / absent rollup →
  the writer simply has no commit/PR or positioning block; output still generates).
- Threading `ctx` into `extractJdSignal` is back-compatible (optional param; absent
  → today's ephemeral context).
- Cost persistence is additive metadata; never blocks the run.

## Testing

- **Unit:** the commit/PR loader (formats authored rows, caps N, fail-open on empty);
  the profile-intelligence formatter (formats seniority, fail-open on absent rollup);
  `extractJdSignal` accumulates into a supplied ctx.
- **Eval:** the extended free-writer eval (B5).
- **Manual:** a live free run shows non-null `metadata.costUsd`/`tokens`, and the
  resume cites at least one PR/commit and opens with a positioning line.

## Acceptance criteria

- Free and paid runs both persist `metadata.costUsd` + `metadata.tokens`
  (LLM-agent cost), in the case-study shape.
- Free run's `metadata.costUsd` includes the JD-extraction + writer cost (shared ctx).
- The free resume cites real commit/PR work and opens with a positioning line, with
  no fabricated facts (eval green).
- **No new LLM calls** in the free path (still: 1 extraction + RAG embeds/rerank + 1
  writer + flag-mode grounding verifier).
- Paid behaviour unchanged except the additive cost metadata.
- ESLint + typecheck clean; no migration.

## Risks & mitigations

- **Commit/PR noise** (e.g. "wip", "fix typo"): cap N + prefer merged PRs and
  longer/conventional commit messages; the writer is told to select impactful work,
  not list everything. The eval guards that cited work is grounded, not fabricated.
- **author_login mismatch** (commits by bots/co-authors): include a row only when
  `author_login` matches the user's GitHub login; if the login is unknown, fall
  back to including PRs (authored by the user via the connected account) and skip
  ambiguous commits.
- **Positioning over-claim**: profile-intelligence seniority is a *positioning aid*,
  not a fact source — the persona forbids using it to invent metrics; only RAG /
  commit-PR / career facts back concrete claims.
- **Cost figure misread as total**: code comment + this spec note the
  embeddings/rerank exclusion.
