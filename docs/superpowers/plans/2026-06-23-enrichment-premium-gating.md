# Enrichment Premium Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the LLM chunk-skill enrichment (Haiku, ~99% of ingestion cost) behind a premium entitlement: free tier runs Tier-1 deterministic skills + RAG/KB + technologies at ~€0 LLM; premium runs full enrichment (with the per-file lever). A test-user-only UI toggle on "Connected Repositories" picks the tier, enforced server-side.

**Architecture:** Two repos, two PRs. **PR 1 (ai-applications):** make `reenrichSkippedChunks`'s LLM enricher optional so a Tier-1-only pass applies deterministic skills with zero Bedrock calls; wire a free-tier branch in `run-ingestion.ts` driven by `ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1`. Defaults unchanged → no behaviour change until the dispatcher sets the env. **PR 2 (tucaken-app):** an `ENRICHMENT_TOGGLE_EMAILS` allowlist + `me.enrichmentToggle`, accept + server-side-enforce an `enrichment: 'premium'|'free'` choice on the repo-sync dispatch → map to the Job env, and a gated toggle modal in the Connected Repositories flow.

**Tech Stack:** TypeScript (ESM), Jest, Postgres (`pg`), Bedrock; tucaken-app: Hono (admin-api), TanStack Start + React 19 (frontend).

## Global Constraints

- **No new LLM call** in the free path (Tier-1 is a DB lookup). **No migration.** Tech extraction, embeddings, RAG retrieval **unchanged**.
- **Defaults preserve current behaviour** in BOTH repos: absent env / non-allowlisted user → exactly today's path. Ship PR 1 first; it's inert until PR 2's dispatcher sets the new env.
- **Server-side enforcement fails closed to the DEFAULT** (never to premium): a non-allowlisted email's choice is ignored. The Job env is set by the trusted admin-api dispatcher, never the client.
- English (UK); complexity ceiling 10; ESLint + typecheck clean per repo; tests green. Commit bodies as impact bullets; NO "Co-Authored-By: Claude" trailer. No `--no-verify` unless a hook is unrelated+broken (note it).
- **Branches:** ai-applications = `spec/enrichment-premium-gating` (current). tucaken-app = a NEW branch `feat/enrichment-premium-toggle` off its default (`develop`).
- **GIT SAFETY (subagents):** never `git checkout`/`switch`/`pull`/`reset`; confirm `git branch --show-current` matches the task's repo branch before committing; stage only the task's files.

---

# PR 1 — ai-applications (ingestion gate). Branch: `spec/enrichment-premium-gating`

## Task 1: make the Tier-1 pass run without an LLM enricher

**Files:**
- Modify: `applications/ingestion/src/util/reenrichSkippedChunks.ts`
- Test: `applications/ingestion/src/util/reenrichSkippedChunks.test.ts` (create if absent)

**Interfaces:**
- Produces: `reenrichSkippedChunks(pool, enricher?: IChunkEnricher, opts)` — `enricher` now OPTIONAL; when absent, Tier-1 (+ dedup cache) skills are applied and the LLM residue is SKIPPED (chunks left as-is, no Bedrock call).

- [ ] **Step 1: Write the failing test**

```typescript
/** @format */
import { reenrichSkippedChunks } from './reenrichSkippedChunks.js';

// Fake pool: returns one chunk with a file_tech_stack that Tier-1 maps to a skill.
function makePool(captured: { updates: unknown[] }) {
    return {
        query: async (sql: string, params?: unknown[]) => {
            if (/SELECT .*file_tech_stack|FROM document_embeddings/i.test(sql)) {
                return { rows: [{ id: 'c1', file_path: 'a.ts', content: 'x', heading: null, file_tech_stack: ['kubernetes'], content_hash: 'h1' }] };
            }
            if (/UPDATE document_embeddings/i.test(sql)) { captured.updates.push(params); return { rowCount: 1 }; }
            return { rows: [] };
        },
    } as never;
}

describe('reenrichSkippedChunks — Tier-1-only (no enricher)', () => {
    it('applies deterministic Tier-1 skills and makes NO LLM call when enricher is absent', async () => {
        const captured = { updates: [] as unknown[] };
        const tier1Map = new Map<string, readonly string[]>([['kubernetes', ['kubernetes networking']]]);
        // enricher omitted entirely — must not throw, must not call any LLM.
        const result = await reenrichSkippedChunks(makePool(captured), undefined, {
            userId: 'u1', repoFullName: 'me/r', tier1Map, dedupCache: false, deadlineMs: 60_000,
        });
        expect(result.tier1Resolved ?? result.enriched ?? 0).toBeGreaterThanOrEqual(0); // shape-tolerant
        expect(captured.updates.length).toBeGreaterThan(0);                              // Tier-1 skills written
    });
});
```

(Match the real `reenrichSkippedChunks` return shape + the real SELECT/UPDATE SQL when you read the file; the assertion that matters is: with `enricher` undefined it does not throw, writes Tier-1 skills, and never calls an enricher method.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd applications/ingestion && yarn test src/util/reenrichSkippedChunks.test.ts`
Expected: FAIL — `enricher` is required / a `.modelId`/`.enrich` access throws on undefined.

- [ ] **Step 3: Implement**

In `reenrichSkippedChunks.ts`:
- Change the signature `enricher: IChunkEnricher` → `enricher?: IChunkEnricher`.
- Guard the model-id/cache-key computation (the `enricher.modelId` reads, ~line 132-133): when `enricher` is undefined, use a fixed key e.g. `'tier1-only'`.
- The Tier-1 resolution (`tier1SkillsFromTech`, ~line 160-161) and the dedup-cache read are unchanged — they don't need the enricher.
- The residue LLM path (`enricher.enrichTextCanonical` / `enricher.enrich`, ~line 198-207): wrap in `if (enricher) { … } else { /* leave residue unresolved — no LLM, no charge */ }`. Chunks unresolved by Tier-1/cache keep their current state (pending/empty); they remain embedded + retrievable.
- Keep all existing behaviour identical when `enricher` IS provided.

- [ ] **Step 4: Run test + the existing suite**

Run: `cd applications/ingestion && yarn test src/util/reenrichSkippedChunks.test.ts && yarn typecheck`
Expected: PASS; existing enricher-present tests unchanged.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/ingestion && npx eslint src/util/reenrichSkippedChunks.ts src/util/reenrichSkippedChunks.test.ts
git add applications/ingestion/src/util/reenrichSkippedChunks.ts applications/ingestion/src/util/reenrichSkippedChunks.test.ts
git commit -m "feat(ingestion): Tier-1 enrichment can run without an LLM enricher

Make the enricher optional in reenrichSkippedChunks: when absent, apply the
deterministic Tier-1 (tech_skill_map) skills + dedup cache and skip the LLM
residue (no Bedrock call). Enables a zero-cost free-tier skill pass."
```

---

## Task 2: free-tier Tier-1-only branch in run-ingestion + telemetry

**Files:**
- Modify: `applications/ingestion/src/run-ingestion.ts`

**Interfaces:**
- Consumes: `reenrichSkippedChunks(pool, undefined, { tier1Map, … })` (Task 1).

- [ ] **Step 1: Implement the free-tier branch**

In `run-ingestion.ts` (the enricher region ~615-672 + the deferred call ~819-821):
- The enricher is already skipped when `ENRICHMENT_DISABLED=1` (`:625`). Add a free-tier post-completion pass: after the repo is marked searchable, when `process.env.ENRICHMENT_DISABLED === '1' && process.env.ENRICH_TIER1 === '1'`, run a `runTier1OnlyPass(pgPool, env.userId, env.repoFullName)` that loads `tier1Map` (the `ENRICH_TIER1` map, as `:220`) and calls `reenrichSkippedChunks(pgPool, undefined, { userId, repoFullName, tier1Map, dedupCache: process.env.ENRICH_DEDUP !== '0', deadlineMs: enrichmentDeadlineMs() })`. Place it next to the existing `if (deferEnrichment && enricher) { await runDeferredEnrichment(...) }` block (~:819) as an `else if (free-tier-tier1) { await runTier1OnlyPass(...) }`.
- **Telemetry:** log the resolved enrichment mode once per run — `'premium'` (enricher present), `'free-tier1-only'` (the new branch), or `'disabled'` — plus the per-run `chunk-enrich` cost already computed by `sumBookedCostUsd`, so a free run is visibly ~€0.

- [ ] **Step 2: Verify defaults unchanged + typecheck**

Run: `cd applications/ingestion && yarn typecheck && yarn test src/`
Expected: PASS. With neither env set (today's default), behaviour is identical (no new branch fires). With `ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1`, the Tier-1-only pass runs and no enricher is constructed.

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/ingestion && npx eslint src/run-ingestion.ts
git add applications/ingestion/src/run-ingestion.ts
git commit -m "feat(ingestion): free-tier Tier-1-only enrichment pass + mode telemetry

When ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1, run a deterministic Tier-1 skill
pass (zero Bedrock) after the repo is searchable, and log the resolved
enrichment mode + per-run chunk-enrich cost. Defaults unchanged."
```

---

## Task 3: dedup-cache 0-hit investigation (timeboxed)

**Files:**
- Investigate: `applications/ingestion/src/util/reenrichSkippedChunks.ts` (the `chunk_enrichment_cache` read/write — `loadEnrichmentCache`/`saveEnrichmentCache`, content-hash keying).

- [ ] **Step 1: Diagnose**

`chunk_enrichment_cache` showed **0 hits** across all re-ingestions (so each re-run re-pays full enrichment). Read the cache key (content_hash + user_id + model_id) and compare against what a re-ingestion writes vs reads. Likely causes: the key includes `model_id`/a canonical-vocab suffix that varies per run, or `content_hash` is computed differently on read vs write, or the cache is written but a force-reindex path bypasses the read.

- [ ] **Step 2: Fix-if-small, else document**

- If it's a one-line keying bug (e.g. the model-id/vocab suffix or a hash mismatch), fix it + add a unit test that a byte-identical chunk hits the cache (no LLM call on the second pass).
- If it needs a larger change, do NOT scope-creep: write the finding (root cause + proposed fix) into the report and the progress ledger as a follow-up, and skip the code change.

- [ ] **Step 3: Commit (only if a fix was made)**

```bash
cd applications/ingestion && npx eslint <changed files>
git add <changed files>
git commit -m "fix(ingestion): <dedup cache key fix> so byte-identical chunks hit the cache"
```

(If no fix: no commit; the finding is recorded in the report. Note in the report whether a fix shipped or it's deferred.)

---

# PR 2 — tucaken-app (admin-api dispatch + frontend toggle). Branch: `feat/enrichment-premium-toggle` off `develop`

> Repo: /Users/nelsonlamounier/Desktop/portfolio/tucaken-app. Create the branch off `develop` first.

## Task 4: admin-api entitlement — `isEnrichmentToggleAllowed` + `me.enrichmentToggle`

**Files:**
- Create: `admin-api/src/lib/enrichment-toggle.ts`
- Create: `admin-api/src/lib/enrichment-toggle.test.ts`
- Modify: `admin-api/src/routes/me.ts`

**Interfaces:**
- Produces: `isEnrichmentToggleAllowed(email?: string): boolean` (reads `ENRICHMENT_TOGGLE_EMAILS` at call time, default `lamounier_88@hotmail.com`); `me` response gains `enrichmentToggle: boolean`.

- [ ] **Step 1: Failing test (mirror `ab-free-tier.ts`)**

Read `admin-api/src/lib/ab-free-tier.ts` (the `isFreeTierAllowed`/`AB_FREE_TIER_EMAILS` pattern) and mirror it. Test:

```typescript
import { isEnrichmentToggleAllowed } from './enrichment-toggle.js';
describe('isEnrichmentToggleAllowed', () => {
    const old = process.env.ENRICHMENT_TOGGLE_EMAILS;
    afterEach(() => { process.env.ENRICHMENT_TOGGLE_EMAILS = old; });
    it('allows an allowlisted email (case-insensitive)', () => {
        process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
        expect(isEnrichmentToggleAllowed('Lamounier_88@hotmail.com')).toBe(true);
    });
    it('denies a non-listed email and undefined', () => {
        process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
        expect(isEnrichmentToggleAllowed('someone@else.com')).toBe(false);
        expect(isEnrichmentToggleAllowed(undefined)).toBe(false);
    });
});
```

- [ ] **Step 2: Run → fail → implement → pass**

Implement `enrichment-toggle.ts` mirroring `ab-free-tier.ts` (env-read at call time, comma-split, trim, lowercase compare; default to `lamounier_88@hotmail.com` when the env is unset). In `me.ts` (the JSON return ~:47-66), add `enrichmentToggle: isEnrichmentToggleAllowed(payload['email'] as string)`.

Run: `cd admin-api && yarn test src/lib/enrichment-toggle.test.ts && yarn typecheck` → PASS.

- [ ] **Step 3: ESLint + commit** (impact-bullet body; no trailer).

---

## Task 5: admin-api — accept + enforce the choice, map to Job env

**Files:**
- Modify: `admin-api/src/routes/github.ts` (the `/github/connected-repos` POST body + `dispatchIngestionJob`)
- Modify: `admin-api/src/lib/ingestion-job.ts` (`IngestionJobOptions` + env assembly)
- Modify: `admin-api/src/routes/ingestion.ts` (the admin `/trigger` body) — optional, mirror
- Test: `admin-api/src/lib/ingestion-job.test.ts`

**Interfaces:**
- Consumes: `isEnrichmentToggleAllowed` (Task 4).
- Produces: a resolver `resolveEnrichmentEnv(email, choice): { ENRICHMENT_DISABLED?, ENRICH_TIER1, ENRICH_PER_FILE? }` and the Job env carries it.

- [ ] **Step 1: Failing test for the resolver + env mapping**

```typescript
// resolveEnrichmentEnv(email, choice) — honour only for allowlisted email, else default.
it('allowlisted + free → ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1', () => {
    process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
    expect(resolveEnrichmentEnv('lamounier_88@hotmail.com', 'free'))
        .toMatchObject({ ENRICHMENT_DISABLED: '1', ENRICH_TIER1: '1' });
});
it('allowlisted + premium → enrichment on + ENRICH_PER_FILE=1 + ENRICH_TIER1=1', () => {
    process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
    const env = resolveEnrichmentEnv('lamounier_88@hotmail.com', 'premium');
    expect(env.ENRICHMENT_DISABLED).toBeUndefined();
    expect(env).toMatchObject({ ENRICH_TIER1: '1', ENRICH_PER_FILE: '1' });
});
it('non-allowlisted email → default regardless of requested choice', () => {
    process.env.ENRICHMENT_TOGGLE_EMAILS = 'lamounier_88@hotmail.com';
    expect(resolveEnrichmentEnv('someone@else.com', 'free')).toEqual({});  // default = current behaviour
});
```

- [ ] **Step 2: Run → fail → implement → pass**

- Add `enrichment?: 'premium' | 'free'` to the `/github/connected-repos` POST body type (`github.ts` ~:1045) and to `dispatchIngestionJob`'s params (~:450), threaded to `buildIngestionJobSpec`.
- Add `resolveEnrichmentEnv(email, choice)` (in `ingestion-job.ts` or a small lib): allowlisted email → map `free`→`{ ENRICHMENT_DISABLED:'1', ENRICH_TIER1:'1' }`, `premium`→`{ ENRICH_TIER1:'1', ENRICH_PER_FILE:'1' }`; non-allowlisted or no choice → `{}` (current default). The email comes from the verified claim available in the route (`ctx.get('jwtPayload')['email']`); thread it to the dispatcher.
- In the env assembly (`ingestion-job.ts` ~:143-187, after the existing `ENRICH_CANONICAL` line), spread the resolved env vars as `{ name, value }` entries (only the keys present).

Run: `cd admin-api && yarn test src/lib/ingestion-job.test.ts && yarn typecheck` → PASS.

- [ ] **Step 3: ESLint + commit** (impact-bullet body; no trailer).

---

## Task 6: frontend — `me.enrichmentToggle` + gated toggle modal

**Files:**
- Modify: `src/server/me.ts` (`MeResponse`)
- Modify: `src/server/github.ts` (`ingestionSchema` + `triggerGitHubIngestionFn`)
- Modify: `src/features/github/components/GitHubConnectedRepos.tsx`
- Test: a component test for the gated modal

**Interfaces:**
- Consumes: `me.enrichmentToggle` (Task 4); the `enrichment` field on the dispatch (Task 5).

- [ ] **Step 1: Wire the data + schema**

- `src/server/me.ts`: add `enrichmentToggle: boolean` to `MeResponse` (~:14-36).
- `src/server/github.ts`: add `enrichment: z.enum(['premium','free']).optional()` to `ingestionSchema` (~:47) and pass `enrichment: data.enrichment` in the `triggerGitHubIngestionFn` request body (~:53-70).

- [ ] **Step 2: Failing component test**

In a test for `GitHubConnectedRepos`: when `me.enrichmentToggle` is true, clicking add/re-sync opens the enrichment modal; when false, it dispatches with no modal (current behaviour). Mock `getMeFn` (wrap renders in QueryClientProvider — mirror the `NewAnalysisPanel` test setup from the resume A/B).

- [ ] **Step 3: Implement the modal (mirror `TierActions`)**

In `GitHubConnectedRepos.tsx`: add a `me` query (`getMeFn`); gate a small modal/toggle on `me.data?.enrichmentToggle`; the modal offers **Full enrichment (premium)** vs **Free-tier sync** (RAG/KB + technologies, no skill enrichment) with a one-line cost note; on choice, call the resync/add mutation with `enrichment: choice`. When `enrichmentToggle` is false, the flow is unchanged (no modal, no `enrichment` field).

- [ ] **Step 4: Run tests + typecheck**

Run (from tucaken-app root): `yarn test src/features/github && yarn typecheck`
Expected: PASS; existing connected-repos tests unaffected.

- [ ] **Step 5: ESLint + commit** (impact-bullet body; no trailer).

---

## Self-Review

**1. Spec coverage:**
- Free = Tier-1 + RAG/KB + technologies, zero LLM → Tasks 1 + 2 (+ env from Task 5). ✓
- Premium = enrichment + per-file → Task 5 env (`ENRICH_PER_FILE`) consumed by existing ingestion. ✓
- Per-sync test-user toggle, server-enforced → Tasks 4 (allowlist + me) + 5 (accept/enforce/env) + 6 (modal). ✓
- Defaults preserve current behaviour (both repos) → Task 2 (no branch fires by default) + Task 5 (non-allowlisted → `{}`). ✓
- Dedup 0-hit → Task 3 (timeboxed). ✓
- Tech extraction / embeddings / RAG untouched → no task changes them. ✓
- No new LLM call / no migration → all tasks. ✓
- Out of scope (backfill, pack/batch, DB entitlements, billing) → not in plan. ✓

**2. Placeholder scan:** The "read X / match the real return shape / mirror ab-free-tier" notes are verify-against-existing-code steps; the new logic (Tier-1-optional decoupling, resolver, modal gating) is specified. The exact line anchors (run-ingestion ~625/819, ingestion-job ~143, github.ts ~1045/1126, me.ts ~47) are confirmed from exploration; the implementer re-confirms before editing. No TBD in delivered code.

**3. Type consistency:** `reenrichSkippedChunks(pool, enricher?, opts)`, `isEnrichmentToggleAllowed(email?)`, `resolveEnrichmentEnv(email, choice)`, `me.enrichmentToggle`, and the `enrichment: 'premium'|'free'` field are consistent across tasks and the two repos. Env keys (`ENRICHMENT_DISABLED`/`ENRICH_TIER1`/`ENRICH_PER_FILE`) match the ingestion job's existing readers.
