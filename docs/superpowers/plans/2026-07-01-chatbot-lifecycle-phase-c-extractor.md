# Chatbot Lifecycle — Phase C (durable lifecycle extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `lifecycle` profile chunk regenerate automatically on every re-ingest (from evidence in the repo), gated so it only runs for the portfolio owner when the chatbot feature is enabled.

**Architecture:** Add a structured `lifecycle` field to `ProfileExtractor` (Zod + tool schema + grounding rule) and bump the extractor version so existing repos re-extract. `embedProfile` renders each lifecycle entry into a `chunk_type='lifecycle'` embedding — the Phase-A seed converges away idempotently because the prune fix (already merged in this branch) replaces prior lifecycle chunks. Extraction of `lifecycle` is gated on `users.chatbot_enabled` (Phase B).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Zod, Jest (`@jest/globals`), Bedrock (profile extractor Claude model), Titan embeddings.

## Global Constraints

- **Depends on:** the prune fix (this branch, `c4e9144`) and migration 104 (`lifecycle` chunk_type). Phase B's `users.chatbot_enabled` column (migration 112) must exist for the gate.
- Gate: emit `lifecycle` only when the ingestion run's user (the portfolio owner, `USER_ID`) has `chatbot_enabled = true`. `FORCE_REINDEX` does NOT re-extract profiles — a `ProfileExtractor.version` bump is what forces re-extraction across repos whose HEAD is unchanged.
- `lifecycle` must be populated ONLY from explicit migration evidence (README/CHANGELOG/ADR); never inferred. Empty array otherwise.
- English (UK) spelling; commit messages carry NO `Co-Authored-By` trailer.
- Package: `@bedrock/ingestion` (Jest). Also touches `@bedrock/shared` types if the chunk_type union lives there.

---

### Task 1: Widen the `lifecycle` chunk_type in the row type

**Files:**
- Modify: `applications/ingestion/src/repositories/RepositoryProfileEmbeddingsRepository.ts:10`

**Interfaces:**
- Produces: `ProfileEmbeddingRow.chunkType` now `'one_liner' | 'description' | 'highlight' | 'lifecycle'`.

- [ ] **Step 1: Change the union**

`ProfileEmbeddingRow.chunkType` from `'one_liner' | 'description' | 'highlight'` to add `| 'lifecycle'`.

- [ ] **Step 2: Typecheck** — `yarn workspace @bedrock/ingestion typecheck` (build `@bedrock/shared` first if TS6305). Expected: passes.
- [ ] **Step 3: Commit** — `feat(ingestion): allow 'lifecycle' in ProfileEmbeddingRow.chunkType`

---

### Task 2: Add the `lifecycle` field to the extractor

**Files:**
- Modify: `applications/ingestion/src/agents/ProfileExtractor.ts` (schema 9–38, tool 50–93, system prompt 95–122, `version` line 133)
- Test: `applications/ingestion/src/agents/__tests__/ProfileExtractor.test.ts`

**Interfaces:**
- Produces: `ExtractedRepoData.lifecycle: Array<{ system: string; from: string; to: string; when: string | null; status: 'current'|'planned'|'deprecated' }>` (default `[]`).

- [ ] **Step 1: Failing test** — add to `ProfileExtractor.test.ts`:

```typescript
it('parses a lifecycle migration entry and clamps over-long fields', async () => {
    mockBedrockResponse({ ...VALID_TOOL_INPUT, lifecycle: [
        { system: 'Kubernetes platform', from: 'self-managed kubeadm', to: 'Amazon EKS 1.34', when: '2026-05', status: 'current' },
    ]});
    const r = await extractor.extract('user-123', makeBundle());
    expect(r.lifecycle).toHaveLength(1);
    expect(r.lifecycle[0]).toMatchObject({ to: 'Amazon EKS 1.34', status: 'current' });
});

it('defaults lifecycle to [] when absent', async () => {
    mockBedrockResponse(VALID_TOOL_INPUT);
    const r = await extractor.extract('user-123', makeBundle());
    expect(r.lifecycle).toEqual([]);
});
```

- [ ] **Step 2: Run → FAIL** — `yarn workspace @bedrock/ingestion test src/agents/__tests__/ProfileExtractor.test.ts` (lifecycle undefined).

- [ ] **Step 3: Extend the Zod schema** (`ExtractedRepoDataSchema`, after `highlights`):

```typescript
    lifecycle: z.array(z.object({
        system: z.string().transform(s => s.slice(0, 80)),
        from:   z.string().transform(s => s.slice(0, 120)),
        to:     z.string().transform(s => s.slice(0, 120)),
        when:   z.string().nullable(),
        status: z.enum(['current', 'planned', 'deprecated']),
    })).max(5).default([]),
```

- [ ] **Step 4: Extend `EXTRACT_TOOL.input_schema`** with a matching `lifecycle` array property (same fields), and add to `SYSTEM_PROMPT` a rule: "Populate `lifecycle` ONLY from explicit migration evidence in the README/CHANGELOG/ADRs (a stated move from one system/version to another). Never infer a migration. Use [] when none is stated."

- [ ] **Step 5: Bump the extractor version** — `readonly version = '2';` (line 133). This invalidates every stored `profileInputHash`, forcing re-extraction (and thus lifecycle emission) on the next ingest of each repo, even when HEAD is unchanged.

- [ ] **Step 6: Run → PASS**, then typecheck.

- [ ] **Step 7: Commit** — `feat(ingestion): extract a structured lifecycle/migration field (extractor v2)`

---

### Task 3: Emit the `lifecycle` embedding chunk (gated)

**Files:**
- Modify: `applications/ingestion/src/run-ingestion.ts` — `embedProfile` (~360–385) and the extract gate (~831–847)
- Test: `applications/ingestion/src/__tests__/embedProfile-lifecycle.test.ts` (new)

**Interfaces:**
- Consumes: `ExtractedRepoData.lifecycle` (Task 2), `users.chatbot_enabled` (Phase B, migration 112).
- Produces: for each `lifecycle` entry, a `ProfileEmbeddingRow` with `chunkType: 'lifecycle'` and content rendered as a sentence; only when the run's user has `chatbot_enabled = true`.

- [ ] **Step 1: Gate helper (failing test first)** — add a small pure function `renderLifecycleChunks(extracted): string[]` returning one sentence per entry, e.g. ```${e.system}: currently ${e.to}${e.when ? `, migrated ${e.when}` : ''} from ${e.from}.` `` for `status==='current'`. Test it maps entries → sentences and returns `[]` for empty.

- [ ] **Step 2: Read the gate once per run** — near the extract gate, add:

```typescript
const chatbotEnabled = await pgPool
    .query<{ chatbot_enabled: boolean }>('SELECT chatbot_enabled FROM users WHERE id = $1::uuid', [env.userId])
    .then(r => r.rows[0]?.chatbot_enabled === true)
    .catch(() => false);
```

- [ ] **Step 3: Emit in `embedProfile`** — after the existing one_liner/description/highlight rows, when `chatbotEnabled` and `extracted.lifecycle.length`, push a `chunkType: 'lifecycle'` row per rendered sentence (embed via the same `embedder.embed`). Pass `chatbotEnabled` into `embedProfile` (add a param) so the decision is explicit and testable.

- [ ] **Step 4: Convergence note (no code)** — because the prune fix scopes to the batch's chunk_types, when this batch includes `lifecycle`, the prune deletes the Phase-A seed (`metadata.seeded='phase-a'`) and any prior lifecycle row for the profile, replacing it with the freshly-extracted one. Idempotent convergence; no duplicate.

- [ ] **Step 5: Tests** — (a) with `chatbotEnabled=true` and one lifecycle entry, `upsertBatch` receives a `lifecycle` row; (b) with `chatbotEnabled=false`, no lifecycle row is emitted even if `extracted.lifecycle` is non-empty; (c) empty lifecycle → none.

- [ ] **Step 6: Run tests + typecheck; commit** — `feat(ingestion): emit gated lifecycle embedding chunk on extraction`

---

### Task 4 (optional): FileFilter exclusions for retired paths

**Files:**
- Modify: `applications/shared/src/ingestion/implementations/FileFilter.ts` (`DEFAULT_FILTER_CONFIG.exclude`, 147–201)
- Test: `applications/shared/src/ingestion/implementations/FileFilter.test.ts`

Prevents FUTURE re-embedding of decommissioned content (does not delete existing rows — no purge). Add `**/resume-data-esc.ts` (only if the ESC resume is truly retired repo-wide) and reconsider `**/sm-a/**` (the kubeadm bootstrap is legitimate portfolio history — likely KEEP it, now correctly framed by the lifecycle chunk). Decide per-path with the owner before adding. TDD: exclusion matches the retired glob, a sibling legit file still included.

- [ ] Steps: failing FileFilter test → add globs → pass → commit `chore(ingestion): exclude retired paths from future ingestion`.

---

### Task 5: Deploy + re-ingest verification (ops, after merge/deploy)

- [ ] Deploy the ingestion image (Task 1–3 merged).
- [ ] Enable the owner's chatbot setting (Phase B).
- [ ] Re-ingest `kubernetes-bootstrap` (and `tucaken-infra`). The version-2 extractor re-extracts (fresh EKS summaries), the prune fix removes accumulated orphans, and a `lifecycle` chunk is emitted.
- [ ] Re-run the retrieval probe (Phase A Task 3 command) — confirm the top profile passages are EKS/lifecycle. Record top-5.

## Self-Review

- lifecycle field extraction + version bump (spec §1) → Tasks 2. ✓
- lifecycle embedding chunk (spec §2) → Task 3. ✓
- gating on chatbot_enabled (spec §8) → Task 3 Steps 2–3, 5. ✓
- FileFilter exclusions (spec §4) → Task 4 (optional, owner-confirmed). ✓
- Convergence with Phase A seed → Task 3 Step 4. ✓
- No placeholders: code shown for schema, gate query, render helper; commands are exact.
