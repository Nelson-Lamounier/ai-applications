# Deferred Per-File Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `reenrichSkippedChunks` (the deferred path premium actually uses) honour `ENRICH_PER_FILE` — batch the LLM residue per file so premium enrichment is ~3.7× cheaper, while keeping Tier-1 + dedup-cache as the zero-LLM pre-pass and preserving skill recall.

**Architecture:** Keep the flag-OFF per-chunk path byte-for-byte. Add a flag-ON path that (Phase A) runs the existing per-chunk dedup-cache + Tier-1 pre-pass to resolve cheap chunks, then (Phase B) groups the residue by file via the exported `groupChunksByFile`, makes ONE canonical/free-text call per file-unit on residue-only content, and fans skills back via the exported `assignSkillsToChunks` surface-match guard. A report-only recall eval gates any default flip. Plus a 1-line tucaken-app comment correction.

**Tech Stack:** TypeScript (ESM), Jest, Postgres (`pg`), Bedrock.

## Global Constraints

- **Flag-OFF / free path: byte-for-byte unchanged.** `ENRICH_PER_FILE !== '1'` → today's per-chunk residue loop; no enricher (free Tier-1-only) → residue skipped. The default stays OFF.
- **Tier-1 + dedup-cache semantics unchanged** — they remain the cheap per-chunk pre-pass (zero LLM); only the *residue* LLM calls are batched. **Residue-only content** is sent (never re-pay for resolved chunks).
- **Recall preserved** via the surface-match fan-back; a report-only eval measures it (≥0.97 gate before any default flip). No new LLM call beyond the residue enrichment that already happens (just batched). No migration.
- English (UK); `applications/` complexity ceiling 10; ESLint + `yarn typecheck` clean. Tests from `applications/ingestion`: `yarn test <path>`.
- Commit bodies as impact bullets; NO "Co-Authored-By: Claude" trailer. No `--no-verify` unless a hook is unrelated+broken (note it).
- **Branches:** ai-applications = `spec/deferred-per-file-enrichment` (current). tucaken-app comment = a NEW tiny branch `fix/enrich-per-file-comment` off `origin/main`.
- **GIT SAFETY (subagents):** never `git checkout`/`switch`/`pull`/`reset`; confirm the repo's branch before committing; stage only the task's files.

---

## Task 1: per-file residue batching in `reenrichSkippedChunks` (ai-applications)

**Files:**
- Modify: `applications/ingestion/src/util/reenrichSkippedChunks.ts`
- Test: `applications/ingestion/src/util/reenrichSkippedChunks.test.ts`

**Interfaces:**
- Reuses (import from `@bedrock/shared`): `groupChunksByFile`, `assignSkillsToChunks`, types `FileEnrichUnit`, `SkillAssignment`, and the `RawChunk` type.
- No public signature change to `reenrichSkippedChunks`.

- [ ] **Step 1: Write failing tests**

Add to `reenrichSkippedChunks.test.ts` (extend the file's existing fake-pool harness). The behaviour to pin:

```typescript
// flag ON: residue grouped by file → ONE enrichText/enrichTextCanonical call PER FILE-UNIT.
it('ENRICH_PER_FILE=1: makes one LLM call per file-unit, not per chunk', async () => {
    process.env.ENRICH_PER_FILE = '1';
    // 3 residue chunks across 2 files (a.ts x2, b.ts x1); none have file_tech_stack (no Tier-1), no cache.
    const calls: string[] = [];
    const enricher = {
        modelId: 'haiku',
        enrichText: async (filePath: string, content: string) => { calls.push(filePath); return { skills: ['kubernetes networking'], technologies: [] }; },
    } as never;
    const pool = makePool({ /* returns the 3 rows with chunk_index + file_path + content incl. the skill term where it should fan back */ });
    const res = await reenrichSkippedChunks(pool, enricher, { userId: 'u1', repoFullName: 'me/r', dedupCache: false, deadlineMs: 60_000 });
    expect(calls.length).toBe(2);              // one call per FILE (a.ts, b.ts), not 3 (per chunk)
    expect(res.enriched).toBe(3);              // all 3 chunks written
});

it('ENRICH_PER_FILE=1: fans a skill back only to chunks whose content surface-matches it', async () => {
    process.env.ENRICH_PER_FILE = '1';
    // file a.ts: chunk1 content mentions "kubernetes", chunk2 does NOT.
    // enrichText returns ['kubernetes networking']; assignSkillsToChunks should put it on chunk1 only.
    // assert the UPDATE for chunk1 carries the skill and chunk2 carries [].
});

it('ENRICH_PER_FILE=1: Tier-1 + cache chunks are resolved with NO LLM call (residue-only)', async () => {
    process.env.ENRICH_PER_FILE = '1';
    // one chunk with file_tech_stack→tier1Map skill (Tier-1), one residue chunk.
    // assert enrichText called ONCE (only for the residue), tier1Resolved===1.
});

it('ENRICH_PER_FILE unset: per-chunk path is unchanged (existing tests pass)', () => { /* existing suite */ });
```

(Use the file's real fake-pool SQL matching + `ReenrichResult` shape. The brief's structure is a starting point — match the actual SELECT/UPDATE + closures when you read the file. `afterEach(() => { delete process.env.ENRICH_PER_FILE; })`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd applications/ingestion && yarn test src/util/reenrichSkippedChunks.test.ts -t "ENRICH_PER_FILE"`
Expected: FAIL — no per-file batching; per-chunk calls = 3.

- [ ] **Step 3: Implement**

In `reenrichSkippedChunks.ts`:
1. **SELECT + row shape:** add `chunk_index` to the residue SELECT (`:115`) and to `interface SkippedRow` (`:73`) as `chunk_index: number`.
2. **Imports:** `import { groupChunksByFile, assignSkillsToChunks } from '@bedrock/shared';` and the `RawChunk`/`FileEnrichUnit` types.
3. **Adapter:** `rowToChunk(row: SkippedRow): RawChunk` → `{ filePath: row.file_path, content: row.content, heading: row.heading ?? undefined, chunkIndex: row.chunk_index, totalChunks: 1 }`. Keep a `Map<string, string>` from `${filePath}::${chunkIndex}` → `row.id` for write-back.
4. **Branch at the worker site (`:226-243`).** Keep today's worker pool for the OFF path. When `process.env.ENRICH_PER_FILE === '1' && enricher?.enrichText`, route to a new `processResiduePerFile(rows)` INSTEAD of the per-chunk worker loop:
   - **Phase A (pre-pass, reuse the existing closures):** for each row in order, run the SAME dedup-cache check + `tier1Skills(row)` the current `processRow` does; write + `remember()` the resolved ones (cache hit → `cacheHits++`; tier1 → `tier1Resolved++`); collect the rest into `residue: SkippedRow[]`. (Factor the cache+tier1 resolve out of `processRow` into a shared `resolveCheap(row): { resolved: boolean }` helper so both paths use identical logic and the OFF path stays unchanged.)
   - **Phase B (residue per-file):** `const units = groupChunksByFile(residue.map(rowToChunk), Number(process.env.ENRICH_PER_FILE_MAX_CHARS ?? '12000') || 12000);` Run units through a bounded-concurrency worker pool (mirror the existing `worker()`/cursor pattern). For each unit:
     - one call on the unit's residue text (`unit.text`): `opts.canonicalVocab && enricher.enrichTextCanonical` → `enrichTextCanonical(opts.canonicalVocab, unit.filePath, unit.text, unit.chunks[0]?.heading)` (use `canonical`, add `newSkills.length` to `newSkillsQueued`); else `enricher.enrichText(unit.filePath, unit.text, unit.chunks[0]?.heading)` (`skills`).
     - fan back: `const assigned = assignSkillsToChunks(unit, skills, () => false);` then for each `{ chunkIndex, skills }`, look up `row.id` via the back-map and `await writeSkills(id, skills); remember(content_hash, skills); enriched++;`.
     - on a unit error: `recordFailure(err)` for the unit's rows (left `pending`); do NOT throw out of the pool.
   - telemetry: `console.info('[reenrichSkippedChunks] per-file residue: '+units.length+' calls for '+residue.length+' chunks ('+(residue.length/Math.max(units.length,1)).toFixed(1)+'x fewer)')`.
   - honour `deadlineMs`/`stoppedEarly`/`onProgress` the same way the per-chunk loop does.
5. Keep `ReenrichResult` fields (`candidates`, `enriched`, `tier1Resolved`, `cacheHits`, `newSkillsQueued`, `failed`, `stoppedEarly`, `remaining`) populated consistently in BOTH paths.

Keep functions ≤ complexity 10 — extract `resolveCheap`, `enrichUnit`, and the worker as named helpers.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd applications/ingestion && yarn test src/util/reenrichSkippedChunks.test.ts && yarn typecheck`
Expected: PASS (new + existing). The flag-OFF tests are unchanged; the flag-ON tests assert one-call-per-file + surface-match fan-back + residue-only.

- [ ] **Step 5: ESLint + commit**

```bash
cd applications/ingestion && npx eslint src/util/reenrichSkippedChunks.ts src/util/reenrichSkippedChunks.test.ts
git add applications/ingestion/src/util/reenrichSkippedChunks.ts applications/ingestion/src/util/reenrichSkippedChunks.test.ts
git commit -m "feat(ingestion): per-file residue batching in the deferred enrichment path

Honour ENRICH_PER_FILE in reenrichSkippedChunks: Tier-1 + dedup-cache stay the
zero-LLM per-chunk pre-pass; the residue is grouped per file (groupChunksByFile),
enriched with one canonical/free-text call per file-unit on residue-only content,
and fanned back to chunks under the assignSkillsToChunks surface-match guard.
~3.7x fewer calls; flag-off path unchanged."
```

---

## Task 2: recall eval `run-per-file-eval.ts` (ai-applications)

**Files:**
- Create: `applications/ingestion/src/run-per-file-eval.ts`
- Test: `applications/ingestion/src/util/perFileEval.test.ts` (a small pure-logic test of the candidate-vs-baseline scoring helper)

**Interfaces:**
- Reuses `computeEnrichEvalMetrics` (`util/enrichEvalMetrics.ts`), `groupChunksByFile`, `assignSkillsToChunks`.

- [ ] **Step 1: Implement the eval (mirror `run-tier1-eval.ts`)**

Read `applications/ingestion/src/run-tier1-eval.ts` for the harness shape (PG connect, sample selection, `computeEnrichEvalMetrics`, logging). Create `run-per-file-eval.ts` that, for a sample of residue chunks (those with NULL/empty skills, capped via an env `PER_FILE_EVAL_LIMIT`):
- **baseline (per-chunk):** call `enricher.enrich(chunk)` (or `enrichTextCanonical` per chunk when canonical) for each chunk → `SkillsByChunk`.
- **candidate (per-file):** `groupChunksByFile(chunks, maxChars)`, one `enrichText`/`enrichTextCanonical` per unit, `assignSkillsToChunks(unit, skills, () => false)` → `SkillsByChunk`.
- `computeEnrichEvalMetrics(baseline, candidate)` → log `recall`, `precision`, `addedSkills`, `droppedSkills`, and the call-count reduction. **Report-only** (no gating, no default flip), exactly like `run-tier1-eval`.

Factor the candidate-build (group → call → fan-back) into a small exported pure-ish helper so the unit test can exercise the fan-back scoring without Bedrock (inject a stub enricher).

- [ ] **Step 2: Unit test the scoring helper**

`perFileEval.test.ts`: with a stub enricher returning a fixed skill set and a 2-file/3-chunk fixture where the skill surface-matches only some chunks, assert the candidate `SkillsByChunk` matches the surface-match expectation and `computeEnrichEvalMetrics` reports `recall` for an identical baseline = 1.0 (parity), and < 1.0 when the candidate drops a baseline skill.

Run: `cd applications/ingestion && yarn test src/util/perFileEval.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 3: ESLint + commit**

```bash
cd applications/ingestion && npx eslint src/run-per-file-eval.ts src/util/perFileEval.test.ts
git add applications/ingestion/src/run-per-file-eval.ts applications/ingestion/src/util/perFileEval.test.ts
git commit -m "test(ingestion): per-file vs per-chunk recall eval (report-only)

Mirror run-tier1-eval: score candidate (per-file group + fan-back) against the
per-chunk baseline with computeEnrichEvalMetrics (recall/precision) so the
ENRICH_PER_FILE default flip is gated on >=0.97 recall. Report-only."
```

(After the build, the controller runs this eval against the test user's repos to confirm recall ≥ 0.97 before any default flip; premium uses the flag opt-in regardless.)

---

## Task 3: correct the misleading comment (tucaken-app)

**Repo:** /Users/nelsonlamounier/Desktop/portfolio/tucaken-app. Branch: NEW `fix/enrich-per-file-comment` off `origin/main`.
**Files:**
- Modify: `admin-api/src/lib/ingestion-job.ts` (the comment ~:21 and ~:72).

- [ ] **Step 1: Implement (comment-only)**

The current comment claims `ENRICH_PER_FILE` "takes precedence over DEFER_ENRICHMENT" — incorrect. Replace with an accurate note: *"`ENRICH_PER_FILE` batches enrichment per file in BOTH the inline path and the deferred (DEFER_ENRICHMENT=1) path; it is independent of DEFER_ENRICHMENT, not a precedence over it."* Comment-only; no code/behaviour change.

- [ ] **Step 2: Verify build + commit**

Run from `admin-api`: the repo's typecheck/lint (comment-only, so a quick `yarn typecheck` suffices). Then:

```bash
git add admin-api/src/lib/ingestion-job.ts
git commit -m "docs(admin-api): correct the ENRICH_PER_FILE / DEFER_ENRICHMENT comment

ENRICH_PER_FILE batches per file in both the inline and deferred paths and is
independent of DEFER_ENRICHMENT — it does not take precedence over it. Comment
only; no behaviour change."
```

---

## Self-Review

**1. Spec coverage:**
- Deferred per-file batching honouring `ENRICH_PER_FILE` → Task 1. ✓
- Tier-1 + dedup-cache stay the zero-LLM pre-pass; residue-only content → Task 1 (Phase A/B). ✓
- Reuse `groupChunksByFile` + `assignSkillsToChunks` surface-match fan-back → Task 1. ✓
- Flag-OFF / free path unchanged; default stays off → Task 1 (branch only on flag). ✓
- Recall eval (report-only, ≥0.97 gate) → Task 2. ✓
- tucaken-app comment correction → Task 3. ✓
- No migration / no inline-path change / no pack-batch → none of the tasks touch them. ✓

**2. Placeholder scan:** The test fake-pool/SQL "match the real shape" notes are verify-against-existing-code steps; the Phase A/B logic, the imports, the adapter, and the call sites are specified. No TBD in delivered code.

**3. Type consistency:** `rowToChunk(row): RawChunk`, `groupChunksByFile(RawChunk[], number): FileEnrichUnit[]`, `assignSkillsToChunks(FileEnrichUnit, string[], SkillEvidence): SkillAssignment[]`, and the `${filePath}::${chunkIndex}` → `row.id` back-map are consistent across the residue path and the eval. `ReenrichResult` fields are populated in both the per-chunk and per-file branches.
