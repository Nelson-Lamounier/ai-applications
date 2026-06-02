# Artifact-Anchored Story-Mining — S8: Design

> **Date:** 2026-06-02 · **Status:** Approved design. Plan next.
> **Goal:** Mine *candidate* DevOps/AI interview stories from a user's repo commit/PR history — with a strict two-artifact honesty bar — so they can later fill the S6 story scaffolds. Final sub-project of the 8-part program.
> **Repo:** `ai-applications` (single PR). **Migration 064.** **Branch:** `feat/story-mining-s8` off develop.
> **Design-input §7 + scope verdict** (riskiest surface → minimal, deterministic, forbid keyword evidence).

## Honesty bar (the whole point)
A story candidate is emitted ONLY when **two corroborating artifacts** exist. Deterministic — NO LLM, NO keyword-only matches. Single-signal matches (a bare "fix" message; `Closes #5` with no metric; a metric with no issue link) emit **nothing**. Available data is limited (`repo_commits`: message only, no diff/files; `repo_pull_requests`: title/body/links) — so only two story types are honestly minable in v1; migration/eval-building are deferred (no corroborating data).

## Components (single PR, ai-applications)

### A. migration `064_story_candidates.sql`
RLS-isolated lane (mirrors `repo_commits` RLS; no explicit GRANT — default privileges cover `tucaken_app`, verified):
```sql
CREATE TABLE IF NOT EXISTS story_candidates (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  story_type     TEXT NOT NULL,   -- 'incident' | 'optimization'
  anchor_key     TEXT NOT NULL,   -- dedup (revert sha / pr number)
  anchors        JSONB NOT NULL,  -- the TWO corroborating artifacts
  confidence     REAL NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_full_name, story_type, anchor_key)
);
-- index (user_id, repo_full_name); ENABLE RLS; policy USING/WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid)
```

### B. `story-mining.ts` — pure detector `mineStoryCandidates(commits, pulls)`
Inputs: arrays of `{ sha, message }` (commits) and `{ number, body, state, htmlUrl }` (pulls). Returns `StoryCandidate[]` = `{ storyType, anchorKey, anchors, confidence }`.
- **incident (0.85):** a commit message matching git's revert format — `/^Revert "(.+)"/m` AND a `/This reverts commit ([0-9a-f]{7,40})/` line → `{ storyType:'incident', anchorKey: revertSha, anchors: { revertSha, originalSha, originalSubject }, confidence:0.85 }`. Self-corroborating (two linked commits); zero keyword inference.
- **optimization (0.70):** a `state='merged'` PR whose `body` has a GitHub structured close — `/(close|fix|resolve)(s|d)?\s+#(\d+)/i` — AND a quantified metric — `/(\d+(\.\d+)?\s?(%|ms|s|x|×)|\d+\s?(→|->)\s?\d+|\$\s?\d[\d,]*)/` → `{ storyType:'optimization', anchorKey: 'pr-'+number, anchors: { prNumber, issueRef, metric, htmlUrl }, confidence:0.70 }`.
- Pure function (no I/O), inline-fixture testable.

### C. `RdsStoryCandidateRepository` + `runStoryMining(pool, userId, repoFullName)`
- Reader: RLS-scoped SELECTs of `repo_commits` (message, sha) + `repo_pull_requests` (number, body, state, html_url) for the user/repo.
- `mineStoryCandidates(...)` → `upsert` each candidate (`ON CONFLICT (user_id,repo_full_name,story_type,anchor_key) DO UPDATE`). Idempotent (re-mining re-upserts).

### D. `run-tech-extract` wiring (4th lane)
After the existing lanes, a **fail-open** step: `runStoryMining(pool, env.userId, env.repoFullName)` (reads the already-ingested commit/PR rows — no tarball needed). Never breaks the job; logs candidate count.

## Data flow
```
ingestion → repo_commits / repo_pull_requests (existing, 045)
run-tech-extract → [NEW lane] runStoryMining → mineStoryCandidates (two-artifact) → story_candidates (RLS)
(future spec) coach/UI pairs candidates with S6 story scaffolds
```

## Honesty & error handling
- Two-artifact anchors only; deterministic; single-signal/keyword → nothing.
- Fail-open lane; RLS-scoped reads + writes.
- Lane-only v1 (no coach/UI surfacing yet — a later spec, gated like the other lanes).
- migration/eval-building story types deferred (data can't honestly corroborate them).

## Testing
- **B (detector):** revert commit → incident candidate (right anchors/confidence); merged PR with `Closes #N` + `-37%` → optimization; NEGATIVES emit nothing — bare "fix bug" message, `Closes #5` with no metric, `120ms→40ms` metric with no issue link, an OPEN (non-merged) PR with both.
- **C:** repo reads RLS-scoped; upsert dedups on the PK; round-trip (fakePool).
- **D:** wiring persists candidates after a run; a throw doesn't fail the job.

## Decomposition
Single PR (ai-applications): migration 064 + story-mining detector + RdsStoryCandidateRepository + runStoryMining + run-tech-extract wiring + tests.

## Out of scope
LLM mining; keyword ranking-hints (forbidden v1); migration/eval-building stories; coach/UI surfacing (later spec, pairs with S6 scaffolds).
