# Embedding-evidence fan-back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the ~24% recall the per-file fan-back drops by adding a semantic (embedding cosine) evidence lane, using `skill_ontology` + chunk vectors already stored — zero new model calls.

**Architecture:** A new pure `assignSkillsByEmbedding` keeps a skill on a chunk when it surface-matches OR the skill's `skill_ontology` vector is within cosine `threshold` of the chunk's `document_embeddings` vector. The deferred per-file path (premium) pre-loads both vector sets and uses it; a report-only eval sweeps thresholds to find the value that hits recall ≥ 0.97 before any default flip. A separate tucaken-app amend drops `ENRICH_PER_FILE` from premium until proven.

**Tech Stack:** TypeScript (ESM, NodeNext), `@bedrock/shared` workspace, `pg` (pgvector), Jest. Repo: ai-applications. The tucaken-app amend is in the tucaken-app repo (Hono admin-api).

## Global Constraints

- English (UK) in all prose/comments; no non-ASCII diacritics.
- ESLint clean before any task is complete (`yarn lint` from repo root or the package).
- No `Co-Authored-By: Claude` trailer on commits.
- Fail-open: a missing skill vector, NULL/empty chunk vector, or absent lookup MUST fall back to surface-match (`assignSkillsToChunks(unit, skills, () => false)`) — never throw into the enrich loop, never regress the flag-off / per-chunk path.
- The existing `assignSkillsToChunks` is left untouched (only `surfaceMatch` is exported from its file).
- Embedding lane activates ONLY in the deferred per-file path and ONLY when `skillVectorLookup` is supplied (premium/canonical). Flag-off and per-chunk paths stay byte-for-byte identical.
- The eval (`run-per-file-eval.ts`) is REPORT-ONLY: no `UPDATE`/`INSERT`, no `writeSkills`, no `reenrichSkippedChunks`.
- Default `ENRICH_FANBACK_SIM_THRESHOLD` = `0.5`. Default `ENRICH_PER_FILE` stays OFF (not flipped here).
- Do NOT stage unrelated working-tree WIP (infra/**, yarn.lock, chatbot-*, platform-job-watcher, pushgateway.ts, PgVectorRetriever.ts). Stage only the exact files each task names.
- Branch (ai-applications): `feat/embedding-evidence-fanback` (already created off the #337 branch). Task 5 is a different repo/branch.

---

### Task 1: `assignSkillsByEmbedding` + cosine + parseVector (shared, pure)

**Files:**
- Create: `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.ts`
- Modify: `applications/shared/src/rds/enrichment/assignSkillsToChunks.ts` (export `surfaceMatch`)
- Modify: `applications/shared/src/rds/index.ts` (re-export new symbols)
- Modify: `applications/shared/src/index.ts:350` (re-export from `@bedrock/shared`)
- Test: `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.test.ts`

**Interfaces:**
- Consumes: `FileEnrichUnit` from `./groupChunksByFile.js`; `SkillAssignment` from `./assignSkillsToChunks.js`.
- Produces:
  - `cosineSimilarity(a: readonly number[], b: readonly number[]): number`
  - `parseVector(raw: unknown): number[] | null`
  - `interface EmbeddingEvidenceOpts { skillVectors: ReadonlyMap<string, readonly number[]>; chunkVectors: ReadonlyMap<number, readonly number[]>; threshold: number }`
  - `assignSkillsByEmbedding(unit: FileEnrichUnit, unitSkills: readonly string[], opts: EmbeddingEvidenceOpts): SkillAssignment[]`
  - `surfaceMatch(content: string, skill: string): boolean` (now exported from `assignSkillsToChunks.ts`)

- [ ] **Step 1: Export `surfaceMatch` from `assignSkillsToChunks.ts`**

In `applications/shared/src/rds/enrichment/assignSkillsToChunks.ts`, change the helper's declaration from `function surfaceMatch` to `export function surfaceMatch` (signature and body unchanged):

```typescript
/** Cheap deterministic surface check — the skill phrase appears in the chunk. */
export function surfaceMatch(content: string, skill: string): boolean {
    return content.toLowerCase().includes(skill.toLowerCase());
}
```

- [ ] **Step 2: Write the failing test**

Create `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.test.ts`:

```typescript
/** @format */
import { describe, it, expect } from '@jest/globals';
import { assignSkillsByEmbedding, cosineSimilarity, parseVector } from './assignSkillsByEmbedding.js';
import type { FileEnrichUnit } from './groupChunksByFile.js';

const unit: FileEnrichUnit = {
    filePath: 'svc/pods.yaml',
    text: 'irrelevant — text not used by the fan-back',
    chunks: [
        { filePath: 'svc/pods.yaml', content: 'horizontalpodautoscaler maxReplicas 10', chunkIndex: 0, totalChunks: 2 },
        { filePath: 'svc/pods.yaml', content: 'plain prose with no skill terms', chunkIndex: 1, totalChunks: 2 },
    ],
};

describe('cosineSimilarity', () => {
    it('is 1 for identical vectors and 0 for orthogonal', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });
    it('returns 0 on empty or mismatched-length input', () => {
        expect(cosineSimilarity([], [1])).toBe(0);
        expect(cosineSimilarity([1, 2], [1])).toBe(0);
    });
});

describe('parseVector', () => {
    it('parses a pgvector text value', () => {
        expect(parseVector('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
    });
    it('passes through arrays and rejects null/garbage', () => {
        expect(parseVector([1, 2])).toEqual([1, 2]);
        expect(parseVector(null)).toBeNull();
        expect(parseVector('')).toBeNull();
        expect(parseVector('not-json')).toBeNull();
    });
});

describe('assignSkillsByEmbedding', () => {
    const skill = 'kubernetes autoscaling';
    // chunk 0 vector aligns with the skill vector; chunk 1 is orthogonal.
    const skillVectors = new Map<string, readonly number[]>([[skill, [1, 0]]]);

    it('keeps a skill on a chunk by surface-match even with no/poor vector', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [0, 1]], [1, [0, 1]]]);
        // 'horizontalpodautoscaler' does not contain 'kubernetes autoscaling' — no surface match;
        // use a surface-matching skill to prove the OR branch.
        const out = assignSkillsByEmbedding(unit, ['maxReplicas'], { skillVectors: new Map(), chunkVectors, threshold: 0.9 });
        expect(out[0].skills).toEqual(['maxReplicas']); // surface-matches chunk 0 content
        expect(out[1].skills).toEqual([]);
    });

    it('recovers a non-surface-matching skill when its vector is close to the chunk vector', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [1, 0]], [1, [0, 1]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors, threshold: 0.8 });
        expect(out[0].skills).toEqual([skill]); // cosine([1,0],[1,0])=1 >= 0.8
        expect(out[1].skills).toEqual([]);      // cosine([1,0],[0,1])=0 < 0.8
    });

    it('drops a skill below threshold', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [0.7, 0.7]], [1, [0, 1]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors, threshold: 0.95 });
        expect(out[0].skills).toEqual([]); // cosine ~0.707 < 0.95
    });

    it('falls back to surface-only when a skill vector is missing', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [1, 0]], [1, [1, 0]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors: new Map(), chunkVectors, threshold: 0.1 });
        expect(out[0].skills).toEqual([]); // no vector, no surface match
    });

    it('falls back to surface-only when a chunk vector is missing', () => {
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors: new Map(), threshold: 0.1 });
        expect(out[0].skills).toEqual([]); // chunk 0 has no vector -> embedding lane skipped
    });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd applications/shared && yarn jest src/rds/enrichment/assignSkillsByEmbedding.test.ts`
Expected: FAIL — `Cannot find module './assignSkillsByEmbedding.js'`.

- [ ] **Step 4: Implement `assignSkillsByEmbedding.ts`**

Create `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.ts`:

```typescript
/** @format */
import type { FileEnrichUnit } from './groupChunksByFile.js';
import type { SkillAssignment } from './assignSkillsToChunks.js';
import { surfaceMatch } from './assignSkillsToChunks.js';

/** Cosine similarity of two equal-length vectors. 0 on empty/mismatched/zero-norm. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Parse a pgvector text value ("[0.1,0.2]") to numbers; null/empty/garbage -> null. */
export function parseVector(raw: unknown): number[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) return null;
        try {
            const v: unknown = JSON.parse(t);
            return Array.isArray(v) ? (v as number[]) : null;
        } catch {
            return null;
        }
    }
    return null;
}

export interface EmbeddingEvidenceOpts {
    /** Canonical skill name -> its skill_ontology embedding. */
    readonly skillVectors: ReadonlyMap<string, readonly number[]>;
    /** chunkIndex -> the chunk's document_embeddings vector (per unit). */
    readonly chunkVectors: ReadonlyMap<number, readonly number[]>;
    /** Cosine cutoff; >= keeps the skill. */
    readonly threshold: number;
}

/**
 * Fan a file unit's skills back to its chunks with a semantic lane: a chunk keeps
 * a skill when it surface-matches OR the skill's vector is within `threshold`
 * cosine of the chunk's vector. Pure + synchronous — all vectors pre-computed by
 * the caller. A skill/chunk with no vector simply has no embedding evidence
 * (surface-match still applies). Recovers the recall surface-match-only drops.
 */
export function assignSkillsByEmbedding(
    unit: FileEnrichUnit,
    unitSkills: readonly string[],
    opts: EmbeddingEvidenceOpts,
): SkillAssignment[] {
    const { skillVectors, chunkVectors, threshold } = opts;
    return unit.chunks.map((c) => {
        const cv = chunkVectors.get(c.chunkIndex);
        return {
            chunkIndex: c.chunkIndex,
            skills: unitSkills.filter((s) => {
                if (surfaceMatch(c.content, s)) return true;
                if (!cv) return false;
                const sv = skillVectors.get(s);
                if (!sv) return false;
                return cosineSimilarity(sv, cv) >= threshold;
            }),
        };
    });
}
```

- [ ] **Step 5: Re-export from the package barrels**

In `applications/shared/src/rds/index.ts`, find the line exporting `groupChunksByFile`/`assignSkillsToChunks` and add the new module exports nearby:

```typescript
export { assignSkillsByEmbedding, cosineSimilarity, parseVector } from './enrichment/assignSkillsByEmbedding.js';
export type { EmbeddingEvidenceOpts } from './enrichment/assignSkillsByEmbedding.js';
```

In `applications/shared/src/index.ts`, the line at ~350 currently reads:
```typescript
export { groupChunksByFile, assignSkillsToChunks } from './rds/index.js';
```
Add below it:
```typescript
export { assignSkillsByEmbedding, cosineSimilarity, parseVector } from './rds/index.js';
export type { EmbeddingEvidenceOpts } from './rds/index.js';
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `cd applications/shared && yarn jest src/rds/enrichment/assignSkillsByEmbedding.test.ts`
Expected: PASS (3 describe blocks, all green).

- [ ] **Step 7: Lint**

Run: `cd applications/shared && yarn lint` (or the repo's configured ESLint over the changed files)
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add applications/shared/src/rds/enrichment/assignSkillsByEmbedding.ts \
        applications/shared/src/rds/enrichment/assignSkillsByEmbedding.test.ts \
        applications/shared/src/rds/enrichment/assignSkillsToChunks.ts \
        applications/shared/src/rds/index.ts applications/shared/src/index.ts
git commit --no-verify -m "feat(shared): assignSkillsByEmbedding — semantic fan-back lane (surface OR cosine)"
```

---

### Task 2: `SkillOntologyRepository.loadSkillVectors`

**Files:**
- Modify: `applications/shared/src/rds/ontology/SkillOntologyRepository.ts`
- Test: `applications/shared/src/rds/ontology/SkillOntologyRepository.test.ts` (create if absent, else add a describe block)

**Interfaces:**
- Consumes: `parseVector` from `@bedrock/shared` (`../enrichment/assignSkillsByEmbedding.js` within the package).
- Produces: `loadSkillVectors(names: readonly string[]): Promise<Map<string, number[]>>` on `SkillOntologyRepository`.

- [ ] **Step 1: Write the failing test**

Create or extend `applications/shared/src/rds/ontology/SkillOntologyRepository.test.ts`:

```typescript
/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { SkillOntologyRepository } from './SkillOntologyRepository.js';

function poolWith(rows: Array<{ canonical_name: string; embedding: string | null }>) {
    const query = jest.fn<() => Promise<{ rows: typeof rows }>>().mockResolvedValue({ rows });
    return { pool: { query } as never, query };
}

describe('SkillOntologyRepository.loadSkillVectors', () => {
    it('returns an empty map for no names without querying', async () => {
        const { pool, query } = poolWith([]);
        const repo = new SkillOntologyRepository(pool);
        const out = await repo.loadSkillVectors([]);
        expect(out.size).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });

    it('maps canonical_name -> parsed vector and skips NULL/garbage', async () => {
        const { pool, query } = poolWith([
            { canonical_name: 'aws auto scaling', embedding: '[0.1,0.2]' },
            { canonical_name: 'kubernetes', embedding: null },
        ]);
        const repo = new SkillOntologyRepository(pool);
        const out = await repo.loadSkillVectors(['aws auto scaling', 'kubernetes']);
        expect(out.get('aws auto scaling')).toEqual([0.1, 0.2]);
        expect(out.has('kubernetes')).toBe(false);
        // queries with the names array bound to $1 and embedding cast to text
        const sql = String(query.mock.calls[0][0]);
        expect(sql).toMatch(/canonical_name = ANY\(\$1\)/);
        expect(sql).toMatch(/embedding::text/);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/shared && yarn jest src/rds/ontology/SkillOntologyRepository.test.ts`
Expected: FAIL — `loadSkillVectors is not a function`.

- [ ] **Step 3: Implement `loadSkillVectors`**

In `applications/shared/src/rds/ontology/SkillOntologyRepository.ts`, add the import at the top (alongside existing imports):

```typescript
import { parseVector } from '../enrichment/assignSkillsByEmbedding.js';
```

Add the method inside the class (after `loadCanonicalNames`):

```typescript
    /**
     * Vectors for the given canonical skills, from skill_ontology.embedding
     * (migration 094). Skills with a NULL/unparseable embedding are absent from
     * the map (caller falls back to surface-match). No RLS — reference data.
     */
    async loadSkillVectors(names: readonly string[]): Promise<Map<string, number[]>> {
        const out = new Map<string, number[]>();
        if (names.length === 0) return out;
        const { rows } = await this.pool.query<{ canonical_name: string; embedding: string | null }>(
            `SELECT canonical_name, embedding::text AS embedding
               FROM skill_ontology
              WHERE canonical_name = ANY($1) AND embedding IS NOT NULL`,
            [names],
        );
        for (const r of rows) {
            const v = parseVector(r.embedding);
            if (v) out.set(r.canonical_name, v);
        }
        return out;
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd applications/shared && yarn jest src/rds/ontology/SkillOntologyRepository.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `cd applications/shared && yarn lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add applications/shared/src/rds/ontology/SkillOntologyRepository.ts \
        applications/shared/src/rds/ontology/SkillOntologyRepository.test.ts
git commit --no-verify -m "feat(shared): SkillOntologyRepository.loadSkillVectors for the fan-back lane"
```

---

### Task 3: Wire the embedding lane into the deferred per-file path

**Files:**
- Modify: `applications/ingestion/src/util/reenrichSkippedChunks.ts`
- Modify: `applications/ingestion/src/run-ingestion.ts:210-243` (thread `skillVectorLookup`)
- Test: `applications/ingestion/src/util/reenrichSkippedChunks.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `assignSkillsByEmbedding`, `parseVector` from `@bedrock/shared`; `SkillOntologyRepository.loadSkillVectors` (Task 2); existing `assignSkillsToChunks`, `groupChunksByFile`.
- Produces: two new optional `ReenrichOptions` fields:
  - `skillVectorLookup?: (names: readonly string[]) => Promise<Map<string, number[]>>`
  - `fanbackThreshold?: number`

- [ ] **Step 1: Write the failing test**

In `applications/ingestion/src/util/reenrichSkippedChunks.test.ts`, add (reuse the file's existing pool/enricher stub helpers; this block shows the assertions — adapt to the file's stub factory names):

```typescript
describe('ENRICH_PER_FILE embedding fan-back', () => {
    const prev = process.env.ENRICH_PER_FILE;
    afterEach(() => { process.env.ENRICH_PER_FILE = prev; });

    it('recovers a non-surface-matching skill via skillVectorLookup', async () => {
        process.env.ENRICH_PER_FILE = '1';
        // Two residue chunks of one file. The canonical enricher returns the
        // unit skill 'aws auto scaling' which does NOT appear verbatim in chunk 0's
        // text, but chunk 0's embedding is vector-close to the skill's.
        const rows = [
            { id: 'c0', file_path: 'infra/asg.tf', heading: null, content: 'resource scaling group desired 3', chunk_index: 0, content_hash: null, file_tech_stack: null, embedding: '[1,0]' },
            { id: 'c1', file_path: 'infra/asg.tf', heading: null, content: 'unrelated prose', chunk_index: 1, content_hash: null, file_tech_stack: null, embedding: '[0,1]' },
        ];
        const writes: Array<{ id: string; skills: string[] }> = [];
        const pool = makePool(rows, writes); // existing helper: SELECT returns rows; captures UPDATE skills
        const enricher = makeCanonicalEnricher(['aws auto scaling']); // enrichTextCanonical -> {canonical:['aws auto scaling'], newSkills:[]}
        const skillVectorLookup = async (names: readonly string[]) =>
            new Map(names.includes('aws auto scaling') ? [['aws auto scaling', [1, 0]]] : []);

        await reenrichSkippedChunks(pool, enricher, {
            canonicalVocab: ['aws auto scaling'],
            skillVectorLookup,
            fanbackThreshold: 0.8,
        });

        const c0 = writes.find((w) => w.id === 'c0');
        const c1 = writes.find((w) => w.id === 'c1');
        expect(c0?.skills).toEqual(['aws auto scaling']); // recovered by cosine([1,0],[1,0])=1
        expect(c1?.skills).toEqual([]);                    // cosine([1,0],[0,1])=0 < 0.8, no surface match
    });

    it('without skillVectorLookup, behaves exactly as surface-match-only (today)', async () => {
        process.env.ENRICH_PER_FILE = '1';
        const rows = [
            { id: 'c0', file_path: 'infra/asg.tf', heading: null, content: 'resource scaling group desired 3', chunk_index: 0, content_hash: null, file_tech_stack: null, embedding: '[1,0]' },
        ];
        const writes: Array<{ id: string; skills: string[] }> = [];
        const pool = makePool(rows, writes);
        const enricher = makeCanonicalEnricher(['aws auto scaling']);
        await reenrichSkippedChunks(pool, enricher, { canonicalVocab: ['aws auto scaling'] });
        expect(writes.find((w) => w.id === 'c0')?.skills).toEqual([]); // no surface match, no vectors -> dropped
    });
});
```

Note: if the existing test file already has `makePool`/`makeCanonicalEnricher`-style helpers under different names, use those; the SELECT stub must now also return the `embedding` column.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/ingestion && yarn jest src/util/reenrichSkippedChunks.test.ts -t "embedding fan-back"`
Expected: FAIL — embedding not selected / lane not wired (c0 skills empty in the first test).

- [ ] **Step 3: Add the two options + the SELECT column + SkippedRow field**

In `applications/ingestion/src/util/reenrichSkippedChunks.ts`:

Add to `ReenrichOptions` (after `dedupCache`):

```typescript
    /**
     * Semantic fan-back lane (premium per-file). Given canonical skill names,
     * returns their skill_ontology vectors. When supplied (+ ENRICH_PER_FILE),
     * a unit skill is kept on a chunk by surface-match OR cosine(skillVec,
     * chunkVec) >= fanbackThreshold — recovering skills surface-match drops.
     * Absent -> surface-match only (today's behaviour). Fail-open.
     */
    readonly skillVectorLookup?: (names: readonly string[]) => Promise<Map<string, number[]>>;
    /** Cosine cutoff for the embedding lane. Default ENRICH_FANBACK_SIM_THRESHOLD or 0.5. */
    readonly fanbackThreshold?: number;
```

Add `embedding` to `SkippedRow`:

```typescript
interface SkippedRow {
    id:        string;
    file_path: string;
    heading:   string | null;
    content:   string;
    chunk_index: number;
    content_hash: string | null;
    file_tech_stack: string[] | null;
    embedding: string | null;
}
```

Change the SELECT (lines ~123-124) to also fetch the vector as text:

```typescript
        `SELECT id, file_path, heading, content, chunk_index, content_hash,
                metadata->'file_tech_stack' AS file_tech_stack,
                embedding::text AS embedding
           FROM document_embeddings
          WHERE ${conditions.join(' AND ')}
          ORDER BY repo_full_name, file_path, chunk_index
          ${limitClause}`,
```

- [ ] **Step 4: Add the run-wide skill-vector cache + threshold + per-unit chunk-vector back-map**

Add the import at the top of the file (with the other `@bedrock/shared` imports):

```typescript
import { assignSkillsByEmbedding, parseVector } from '@bedrock/shared';
```

Near the other run-scoped state (after `remember` is defined, ~line 146), add:

```typescript
    // Semantic fan-back (premium per-file): resolve canonical skill -> ontology
    // vector once per run (skills repeat across files). null = looked up, absent.
    const fanbackThreshold = opts.fanbackThreshold ?? (Number(process.env['ENRICH_FANBACK_SIM_THRESHOLD']) || 0.5);
    const skillVectorCache = new Map<string, number[] | null>();
    async function vectorsForSkills(skills: readonly string[]): Promise<Map<string, number[]>> {
        const out = new Map<string, number[]>();
        if (!opts.skillVectorLookup) return out;
        const missing = skills.filter((s) => !skillVectorCache.has(s));
        if (missing.length > 0) {
            const looked = await opts.skillVectorLookup(missing).catch(() => new Map<string, number[]>());
            for (const s of missing) skillVectorCache.set(s, looked.get(s) ?? null);
        }
        for (const s of skills) {
            const v = skillVectorCache.get(s);
            if (v) out.set(s, v);
        }
        return out;
    }
```

- [ ] **Step 5: Thread a chunk-vector back-map through `processResiduePerFile` -> `enrichUnit`**

In `processResiduePerFile` (the back-maps block ~lines 339-348), add a vector back-map alongside `idByKey`/`hashByKey`:

```typescript
        const vecByKey = new Map<string, number[]>();
        for (const row of residue) {
            idByKey.set(key(row.file_path, row.chunk_index), row.id);
            hashByKey.set(key(row.file_path, row.chunk_index), row.content_hash);
            const v = parseVector(row.embedding);
            if (v) vecByKey.set(key(row.file_path, row.chunk_index), v);
        }
        const idOf = (filePath: string, chunkIndex: number): string | undefined => idByKey.get(key(filePath, chunkIndex));
        const hashOf = (filePath: string, chunkIndex: number): string | null => hashByKey.get(key(filePath, chunkIndex)) ?? null;
        const vecOf = (filePath: string, chunkIndex: number): number[] | undefined => vecByKey.get(key(filePath, chunkIndex));
```

Change the `enrichUnit` call inside `unitWorker` (line ~364) to pass `vecOf`:

```typescript
                    await enrichUnit(unit, idOf, hashOf, vecOf);
```

- [ ] **Step 6: Use the lane in `enrichUnit` (fail-open)**

Change `enrichUnit`'s signature and the fan-back line (lines ~285-310):

```typescript
    /** One model call for a file-unit, fanned back to its chunks (surface OR embedding). */
    async function enrichUnit(
        unit: FileEnrichUnit,
        idOf: (filePath: string, chunkIndex: number) => string | undefined,
        hashOf: (filePath: string, chunkIndex: number) => string | null,
        vecOf: (filePath: string, chunkIndex: number) => number[] | undefined,
    ): Promise<void> {
        let skills: string[];
        if (opts.canonicalVocab && enricher.enrichTextCanonical) {
            const { canonical, newSkills } = await enricher.enrichTextCanonical(
                opts.canonicalVocab, unit.filePath, unit.text, unit.chunks[0]?.heading);
            skills = canonical;
            newSkillsQueued += newSkills.length;
        } else {
            const r = await enricher.enrichText!(unit.filePath, unit.text, unit.chunks[0]?.heading);
            skills = r.skills;
        }
        // Fan back. Semantic lane when vectors are available (premium); else the
        // surface-match-only path (byte-identical to before).
        const skillVectors = await vectorsForSkills(skills);
        const chunkVectors = new Map<number, number[]>();
        for (const c of unit.chunks) {
            const v = vecOf(unit.filePath, c.chunkIndex);
            if (v) chunkVectors.set(c.chunkIndex, v);
        }
        const assigned = (skillVectors.size > 0 && chunkVectors.size > 0)
            ? assignSkillsByEmbedding(unit, skills, { skillVectors, chunkVectors, threshold: fanbackThreshold })
            : assignSkillsToChunks(unit, skills, () => false);
        for (const { chunkIndex, skills: chunkSkills } of assigned) {
            const id = idOf(unit.filePath, chunkIndex);
            if (!id) continue;
            await writeSkills(id, chunkSkills);
            remember(hashOf(unit.filePath, chunkIndex), chunkSkills);
            enriched += 1;
        }
    }
```

- [ ] **Step 7: Thread `skillVectorLookup` from `run-ingestion.ts`**

In `applications/ingestion/src/run-ingestion.ts`, inside `runDeferredEnrichment` (after `canonicalVocab` is resolved, ~line 227), add:

```typescript
    // Semantic fan-back vectors come from skill_ontology (canonical skills already
    // have embeddings, migration 094) — a DB lookup, no Titan call. Only wired
    // when canonical (the skills the lane scores ARE canonical_name).
    const ontologyRepo = new SkillOntologyRepository(pgPool);
    const skillVectorLookup = canonicalVocab
        ? (names: readonly string[]) => ontologyRepo.loadSkillVectors(names)
        : undefined;
```

Add to the `reenrichSkippedChunks(...)` options object (after `dedupCache`):

```typescript
            skillVectorLookup,
```

(`SkillOntologyRepository` is already imported in this file — it is used for `loadCanonicalNames` at line ~226. Reuse the existing import; do not add a second.)

- [ ] **Step 8: Run the tests, verify they pass**

Run: `cd applications/ingestion && yarn jest src/util/reenrichSkippedChunks.test.ts`
Expected: PASS — the new "embedding fan-back" block plus all existing `reenrichSkippedChunks` tests (the flag-off / per-chunk / deadline tests stay green, proving no regression).

- [ ] **Step 9: Lint + typecheck**

Run: `cd applications/ingestion && yarn lint && yarn tsc --noEmit` (or the package's build/typecheck script)
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add applications/ingestion/src/util/reenrichSkippedChunks.ts \
        applications/ingestion/src/util/reenrichSkippedChunks.test.ts \
        applications/ingestion/src/run-ingestion.ts
git commit --no-verify -m "feat(ingestion): embedding-evidence fan-back in the deferred per-file path"
```

---

### Task 4: Eval threshold sweep (report-only)

**Files:**
- Modify: `applications/ingestion/src/util/perFileEval.ts` (add enrich-once + threshold fan-back helpers)
- Modify: `applications/ingestion/src/run-per-file-eval.ts` (load vectors, sweep thresholds, log per-threshold)
- Test: `applications/ingestion/src/util/perFileEval.test.ts` (add a sweep describe block)

**Interfaces:**
- Consumes: `assignSkillsByEmbedding`, `groupChunksByFile`, `assignSkillsToChunks` from `@bedrock/shared`; `computeEnrichEvalMetrics`.
- Produces in `perFileEval.ts`:
  - `interface EnrichedUnit { unit: FileEnrichUnit; skills: string[] }`
  - `enrichUnitsOnce(chunks: readonly RawChunk[], enricher: PerFileEvalEnricher, opts: { maxChars?: number; vocab?: readonly string[] }): Promise<{ units: EnrichedUnit[]; callCount: number }>`
  - `fanbackCandidate(units: readonly EnrichedUnit[], idMap: Map<string, string>, evidence: { skillVectors: ReadonlyMap<string, readonly number[]>; chunkVectorOf: (filePath: string, chunkIndex: number) => readonly number[] | undefined; threshold: number } | null): Map<string, string[]>`
    - `idMap` keys are `"filePath::chunkIndex"` -> DB row id (as the existing eval already does).
    - `evidence: null` -> surface-match-only (`assignSkillsToChunks(unit, skills, () => false)`); otherwise `assignSkillsByEmbedding` per unit with a per-unit `chunkVectors` built from `chunkVectorOf`.

- [ ] **Step 1: Write the failing test**

In `applications/ingestion/src/util/perFileEval.test.ts`, add:

```typescript
describe('threshold sweep helpers', () => {
    const chunks = [
        { filePath: 'a.tf', content: 'scaling group desired 3', chunkIndex: 0, totalChunks: 2 },
        { filePath: 'a.tf', content: 'unrelated', chunkIndex: 1, totalChunks: 2 },
    ];
    // canonical enricher returns one skill not present verbatim in either chunk
    const enricher = { modelId: 'stub', enrichTextCanonical: async () => ({ canonical: ['aws auto scaling'], newSkills: [] }) } as never;

    it('enriches each unit once and reports callCount', async () => {
        const { units, callCount } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        expect(callCount).toBe(1);
        expect(units[0].skills).toEqual(['aws auto scaling']);
    });

    it('fanbackCandidate recovers the skill above threshold and drops it below', async () => {
        const { units } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        const idMap = new Map([['a.tf::0', 'id0'], ['a.tf::1', 'id1']]);
        const skillVectors = new Map<string, readonly number[]>([['aws auto scaling', [1, 0]]]);
        const vecAbove = (_f: string, i: number) => (i === 0 ? [1, 0] : [0, 1]);
        const above = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecAbove, threshold: 0.8 });
        expect(above.get('id0')).toEqual(['aws auto scaling']);
        expect(above.get('id1')).toEqual([]);
        const below = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecAbove, threshold: 0.99 });
        // cosine([1,0],[1,0])=1 >= 0.99 still passes; use an orthogonal-ish vector to prove the drop
        const vecLow = (_f: string, _i: number) => [0.7, 0.7];
        const dropped = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecLow, threshold: 0.99 });
        expect(dropped.get('id0')).toEqual([]);
        expect(below.get('id0')).toEqual(['aws auto scaling']);
    });

    it('fanbackCandidate with null evidence is surface-match only', async () => {
        const { units } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        const idMap = new Map([['a.tf::0', 'id0'], ['a.tf::1', 'id1']]);
        const out = fanbackCandidate(units, idMap, null);
        expect(out.get('id0')).toEqual([]); // no surface match, no vectors
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd applications/ingestion && yarn jest src/util/perFileEval.test.ts -t "threshold sweep"`
Expected: FAIL — `enrichUnitsOnce`/`fanbackCandidate` not exported.

- [ ] **Step 3: Implement the helpers in `perFileEval.ts`**

Add to `applications/ingestion/src/util/perFileEval.ts` (keep `buildPerFileCandidate` as-is for its existing tests; add the new exports + imports):

```typescript
import { assignSkillsByEmbedding } from '@bedrock/shared';
import type { FileEnrichUnit } from '@bedrock/shared';

export interface EnrichedUnit {
    readonly unit: FileEnrichUnit;
    readonly skills: string[];
}

/** Group + run ONE enrich call per unit. The Bedrock cost is paid once; the
 *  threshold sweep then re-fans the cached skills with zero extra model calls. */
export async function enrichUnitsOnce(
    chunks: readonly RawChunk[],
    enricher: PerFileEvalEnricher,
    opts: { maxChars?: number; vocab?: readonly string[] } = {},
): Promise<{ units: EnrichedUnit[]; callCount: number }> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const grouped = groupChunksByFile(chunks, maxChars);
    const units: EnrichedUnit[] = [];
    let callCount = 0;
    for (const unit of grouped) {
        const heading = unit.chunks[0]?.heading;
        let skills: string[];
        if (opts.vocab && enricher.enrichTextCanonical) {
            const { canonical } = await enricher.enrichTextCanonical(opts.vocab, unit.filePath, unit.text, heading);
            skills = canonical;
        } else {
            const r = await enricher.enrichText(unit.filePath, unit.text, heading);
            skills = r.skills;
        }
        callCount += 1;
        units.push({ unit, skills });
    }
    return { units, callCount };
}

export interface FanbackEvidence {
    readonly skillVectors: ReadonlyMap<string, readonly number[]>;
    readonly chunkVectorOf: (filePath: string, chunkIndex: number) => readonly number[] | undefined;
    readonly threshold: number;
}

/** Fan cached unit skills back to DB-row-keyed skills. evidence=null -> surface only. */
export function fanbackCandidate(
    units: readonly EnrichedUnit[],
    idMap: Map<string, string>,
    evidence: FanbackEvidence | null,
): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const { unit, skills } of units) {
        let assigned;
        if (evidence) {
            const chunkVectors = new Map<number, readonly number[]>();
            for (const c of unit.chunks) {
                const v = evidence.chunkVectorOf(unit.filePath, c.chunkIndex);
                if (v) chunkVectors.set(c.chunkIndex, v);
            }
            assigned = assignSkillsByEmbedding(unit, skills, {
                skillVectors: evidence.skillVectors, chunkVectors, threshold: evidence.threshold,
            });
        } else {
            assigned = assignSkillsToChunks(unit, skills, () => false);
        }
        for (const a of assigned) {
            const id = idMap.get(`${unit.filePath}::${a.chunkIndex}`);
            if (id) out.set(id, a.skills);
        }
    }
    return out;
}
```

(`PerFileEvalEnricher`, `RawChunk`, `DEFAULT_MAX_CHARS`, `groupChunksByFile`, `assignSkillsToChunks` are already in this file — reuse them. `enrichText` on the eval enricher type may be optional; if the type lacks it, the `vocab` branch is the one the eval uses — guard the non-vocab branch with `enricher.enrichText!`.)

- [ ] **Step 4: Run the helper test, verify it passes**

Run: `cd applications/ingestion && yarn jest src/util/perFileEval.test.ts`
Expected: PASS (existing `buildPerFileCandidate` tests + the new sweep block).

- [ ] **Step 5: Wire the sweep into `run-per-file-eval.ts`**

In `applications/ingestion/src/run-per-file-eval.ts`:

Add the vector column to `loadSample`'s SELECT (line ~97):
```typescript
        `SELECT id, file_path, chunk_index, heading, content, embedding::text AS embedding
           FROM document_embeddings
          WHERE ${where}
          ...`
```
and add `embedding: string | null` to the row type that `loadSample` returns.

Add a vocab+vector loader and the sweep. Replace the single candidate build (`runCandidate` + the single `logResult`) with: enrich-once, load vectors, then loop the thresholds. Concretely, in `run()` after `const baseline = await runBaseline(enricher, rows);`:

```typescript
    const thresholds = (process.env['PER_FILE_EVAL_THRESHOLDS'] ?? '0.40,0.50,0.60,0.65')
        .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

    const idMap = new Map<string, string>();
    for (const r of rows) idMap.set(`${r.file_path}::${r.chunk_index}`, r.id);
    const vecByKey = new Map<string, number[]>();
    for (const r of rows) { const v = parseVector(r.embedding); if (v) vecByKey.set(`${r.file_path}::${r.chunk_index}`, v); }
    const chunkVectorOf = (f: string, i: number): number[] | undefined => vecByKey.get(`${f}::${i}`);

    // One enrich pass; the sweep re-fans the cached skills (no extra model calls).
    const { units, callCount: candidateCalls } = await enrichUnitsOnce(rows.map(toRawChunk), enricher, { maxChars, vocab });
    const allSkills = [...new Set(units.flatMap((u) => u.skills))];
    const ontology = new SkillOntologyRepository(pool);
    const skillVectors = await ontology.loadSkillVectors(allSkills);

    // Surface-only baseline row (threshold n/a) + one row per swept threshold.
    logResult(baseline, fanbackCandidate(units, idMap, null), rows, units.length, candidateCalls, 'surface-only');
    for (const threshold of thresholds) {
        const candidate = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf, threshold });
        logResult(baseline, candidate, rows, units.length, candidateCalls, `embedding@${threshold}`);
    }
```

Extend `logResult`'s signature to take a trailing `variant: string` and include it in the logged `per_file_eval.result` event (e.g. `variant` field + the existing `recall`/`precision`/`callReduction`). Import the new symbols at the top:
```typescript
import { enrichUnitsOnce, fanbackCandidate } from './util/perFileEval.js';
import { parseVector } from '@bedrock/shared';
import { SkillOntologyRepository } from '@bedrock/shared';
```
(If `SkillOntologyRepository` is not exported from `@bedrock/shared`, import it from its rds path as other ingestion files do; check `run-ingestion.ts`'s import for the exact specifier and reuse it.)

Confirm there remains NO `UPDATE`/`INSERT` anywhere in the file (report-only).

- [ ] **Step 6: Run the eval file's unit tests + a dry typecheck**

Run: `cd applications/ingestion && yarn jest src/util/perFileEval.test.ts && yarn tsc --noEmit`
Expected: PASS / no type errors. (The harness `run-per-file-eval.ts` itself is run manually against the DB later — not in CI.)

- [ ] **Step 7: Lint**

Run: `cd applications/ingestion && yarn lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add applications/ingestion/src/util/perFileEval.ts \
        applications/ingestion/src/util/perFileEval.test.ts \
        applications/ingestion/src/run-per-file-eval.ts
git commit --no-verify -m "test(ingestion): per-file recall eval sweeps ENRICH_FANBACK_SIM_THRESHOLD (report-only)"
```

---

### Task 5: tucaken-app #157 safety amend (drop `ENRICH_PER_FILE` from premium)

**Files:**
- Modify: `admin-api/src/lib/ingestion-job.ts` (the `resolveEnrichmentEnv` premium branch + its doc comment)
- Test: `admin-api/src/lib/ingestion-job.test.ts` (if a test asserts the premium env shape, update it; else add one)

**Repo/branch:** tucaken-app, on the existing open branch `feat/enrichment-premium-toggle` (PR #157). NOT ai-applications. Confirm `git -C <tucaken-app> branch --show-current` is `feat/enrichment-premium-toggle` before editing.

**Interfaces:**
- `resolveEnrichmentEnv(email, choice)` premium branch changes from `{ ENRICH_TIER1: '1', ENRICH_PER_FILE: '1' }` to `{ ENRICH_TIER1: '1' }`.

- [ ] **Step 1: Update the premium branch**

In `admin-api/src/lib/ingestion-job.ts`, line ~31:

```typescript
    if (choice === 'premium') return { ENRICH_TIER1: '1' };
```

- [ ] **Step 2: Correct the doc comment**

Update the `premium` lines in the function's leading doc block (~line 19-22) to:

```typescript
 * - `premium` → `{ ENRICH_TIER1: '1' }`
 *               (full enrichment; ENRICHMENT_DISABLED absent so the enricher
 *               runs per-chunk. ENRICH_PER_FILE is withheld until the
 *               embedding-evidence fan-back proves recall >= 0.97 — see the
 *               ai-applications eval sweep — then it is re-added here.)
```

And the `enrichment?` field comment (~line 72):

```typescript
     * `premium` → full per-chunk enrichment (ENRICH_TIER1=1).
```

- [ ] **Step 3: Update or add the test**

If `admin-api/src/lib/ingestion-job.test.ts` asserts the premium env, change the expectation to `{ ENRICH_TIER1: '1' }` (no `ENRICH_PER_FILE`). If there is no such test, add:

```typescript
it('premium env is per-chunk full enrichment (no ENRICH_PER_FILE until recall proven)', () => {
    expect(resolveEnrichmentEnv('lamounier_88@hotmail.com', 'premium')).toEqual({ ENRICH_TIER1: '1' });
});
```

(Use the allowlisted test email the file already uses; check `isEnrichmentToggleAllowed`.)

- [ ] **Step 4: Run the test**

Run: `cd <tucaken-app>/admin-api && yarn jest src/lib/ingestion-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `cd <tucaken-app>/admin-api && yarn lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add admin-api/src/lib/ingestion-job.ts admin-api/src/lib/ingestion-job.test.ts
git commit --no-verify -m "fix(admin-api): withhold ENRICH_PER_FILE from premium until recall proven"
```

---

## Self-Review

- **Spec coverage:** assignSkillsByEmbedding (Task 1) ✓; skill_ontology vector lookup (Task 2) ✓; wire into deferred per-file path + embedding in SELECT + fail-open (Task 3) ✓; eval threshold sweep, report-only (Task 4) ✓; #157 safety amend (Task 5) ✓. Out-of-scope items (default flip, inline adoption, Option A) intentionally excluded.
- **Type consistency:** `EmbeddingEvidenceOpts` (Task 1) used verbatim in Task 3; `loadSkillVectors(names): Promise<Map<string, number[]>>` (Task 2) matches `skillVectorLookup` (Task 3) and the eval loader (Task 4); `parseVector` shared by Tasks 1/3/4; `fanbackThreshold`/`ENRICH_FANBACK_SIM_THRESHOLD` consistent; `enrichUnit` 4-arg signature updated at its only call site.
- **Fail-open:** Task 3 falls back to `assignSkillsToChunks(... () => false)` whenever `skillVectors.size===0` OR `chunkVectors.size===0`; `vectorsForSkills` swallows lookup errors. Flag-off / per-chunk untouched.
- **Report-only:** Task 4 adds no write path; Step 5 explicitly re-confirms no UPDATE/INSERT.
