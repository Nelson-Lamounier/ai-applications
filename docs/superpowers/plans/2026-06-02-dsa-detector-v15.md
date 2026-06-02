# DSA Real-Work Pattern Detector (v1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit honest real-work DSA evidence (5 high-precision signals) into a dedicated, RLS-isolated `dsa_evidence` lane that never touches the technology graph.

**Architecture:** A standalone `DsaPatternExtractor` (pure detector functions, inline-string tests) emits `RawDsaEvidence`; a `DsaTopicResolver` validates each hint against `dsa_topics` (drop-if-unknown, never invent); `RdsDsaEvidenceRepository` persists to `dsa_evidence` (RLS per user). Wired into the existing `run-tech-extract` job (fail-open). No change to `technology_ontology`/`technology_evidence`/`techgraph.ts`.

**Tech Stack:** TypeScript, Node, Jest (`@jest/globals`), pg, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-06-02-dsa-detector-v15-design.md`

---

## Task 1: migration 054 — `dsa_evidence` table

**Files:**
- Create: `applications/platform-rds-bootstrap/migrations/054_dsa_evidence.sql`

- [ ] **Step 1: Write the migration** (mirror RLS from `034_technology_graph.sql`; FK to `dsa_topics`, NOT `technology_ontology`):

```sql
-- 054_dsa_evidence.sql — dedicated, RLS-isolated lane for real-work DSA pattern evidence.
-- Standalone: FK to dsa_topics(canonical_name) only. Never enters technology_ontology /
-- technology_evidence, so skill-graph + KB-quality consumers are unaffected (v1.5 fork, 2026-06-02).
BEGIN;

CREATE TABLE IF NOT EXISTS dsa_evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  dsa_topic      TEXT NOT NULL REFERENCES dsa_topics(canonical_name),
  signal         TEXT NOT NULL,
  raw_name       TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  line_start     INT,
  confidence     REAL NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dsa_evidence_user_repo ON dsa_evidence (user_id, repo_full_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dsa_evidence
  ON dsa_evidence (user_id, repo_full_name, commit_sha, dsa_topic, file_path, line_start);

ALTER TABLE dsa_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dsa_evidence_user_isolation ON dsa_evidence;
CREATE POLICY dsa_evidence_user_isolation ON dsa_evidence
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
```

- [ ] **Step 2: Apply to dev** via the ephemeral psql pod pattern (see Task-5 note / prior 053 apply). Verify: `\d dsa_evidence` shows the FK + RLS enabled.

- [ ] **Step 3: Commit** — `git add … && git commit -m "feat(stage-prep): dsa_evidence table (migration 054, RLS-isolated lane)"`

---

## Task 2: `DsaPatternExtractor` — 5 detectors (TDD)

**Files:**
- Create: `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts`
- Test: `applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts`

Detectors are pure functions over source text. Define the type + a local lang map (decoupled from `TreeSitterExtractor`'s private `Lang`).

- [ ] **Step 1: Write failing tests** (positive + the do-NOT-detect negatives):

```typescript
import { describe, it, expect } from '@jest/globals';
import { detectDsaPatterns } from './DsaPatternExtractor.js';

describe('detectDsaPatterns — admissible signals', () => {
  it('1. networkx import → dsa_graph_traversal @0.80 with line', () => {
    const out = detectDsaPatterns('import os\nimport networkx as nx\n', 'python', 'g.py');
    expect(out).toEqual([{ raw_name: 'networkx', topic_hint: 'dsa_graph_traversal',
      signal: 'networkx_import', confidence: 0.80, file_path: 'g.py', line_start: 2 }]);
  });
  it('2. heapq / PriorityQueue → dsa_heaps @0.78', () => {
    expect(detectDsaPatterns('import heapq\n', 'python', 'h.py')[0]).toMatchObject(
      { topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 });
    expect(detectDsaPatterns('from queue import PriorityQueue\n', 'python', 'h.py')[0])
      .toMatchObject({ topic_hint: 'dsa_heaps' });
    expect(detectDsaPatterns('import java.util.PriorityQueue;\n', 'java', 'H.java')[0])
      .toMatchObject({ topic_hint: 'dsa_heaps' });
  });
  it('3. explicit tree/trie type def → dsa_trees / dsa_tries @0.75', () => {
    expect(detectDsaPatterns('class TreeNode:\n    pass\n', 'python', 't.py')[0])
      .toMatchObject({ topic_hint: 'dsa_trees', signal: 'tree_type', confidence: 0.75 });
    expect(detectDsaPatterns('class TrieNode {}\n', 'typescript', 't.ts')[0])
      .toMatchObject({ topic_hint: 'dsa_tries' });
  });
  it('4. declarative memoization decorator → dsa_dynamic_programming @0.72', () => {
    expect(detectDsaPatterns('@functools.lru_cache(None)\ndef f(): ...\n', 'python', 'm.py')[0])
      .toMatchObject({ topic_hint: 'dsa_dynamic_programming', signal: 'memoization', confidence: 0.72 });
    expect(detectDsaPatterns('@cache\ndef f(): ...\n', 'python', 'm.py').length).toBe(1);
  });
  it('5. custom comparator sort → dsa_sorting @0.70', () => {
    expect(detectDsaPatterns('xs.sort(key=lambda x: x.cost)\n', 'python', 's.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 });
  });
});

describe('detectDsaPatterns — do NOT detect (necessary-not-sufficient)', () => {
  it('sliding window range/len → nothing', () =>
    expect(detectDsaPatterns('for i in range(len(a)):\n    w = a[i:i+k]\n', 'python', 'x.py')).toEqual([]));
  it('dp[] / nested loops → nothing', () =>
    expect(detectDsaPatterns('dp = [[0]*n for _ in range(m)]\n', 'python', 'x.py')).toEqual([]));
  it('plain recursion → nothing', () =>
    expect(detectDsaPatterns('def walk(d):\n    walk(d.parent)\n', 'python', 'x.py')).toEqual([]));
  it('generic deque/Queue → nothing', () => {
    expect(detectDsaPatterns('from collections import deque\n', 'python', 'x.py')).toEqual([]);
    expect(detectDsaPatterns('import java.util.Queue;\n', 'java', 'X.java')).toEqual([]);
  });
  it('generic stack via list.append/pop, set ops → nothing', () =>
    expect(detectDsaPatterns('s=[]\ns.append(1)\ns.pop()\nseen=set()\n', 'python', 'x.py')).toEqual([]));
  it('plain sort without comparator → nothing', () =>
    expect(detectDsaPatterns('xs.sort()\nsorted(xs)\n', 'python', 'x.py')).toEqual([]));
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -w applications/tech-extractor -- src/extractors/DsaPatternExtractor.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `DsaPatternExtractor.ts`:

```typescript
/** @format */
export type DsaLang = 'python' | 'typescript' | 'javascript' | 'java';

export interface RawDsaEvidence {
  readonly raw_name: string;
  readonly topic_hint: string;
  readonly signal: string;
  readonly confidence: number;
  readonly file_path: string;
  readonly line_start: number;
}

const DSA_EXT_LANG: Record<string, DsaLang> = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.java': 'java',
};
export function dsaLangForExt(ext: string): DsaLang | null { return DSA_EXT_LANG[ext] ?? null; }

// Each detector returns matches for ONE line. Keep patterns sufficient-not-necessary.
type Detector = (line: string, lang: DsaLang) => Omit<RawDsaEvidence, 'file_path' | 'line_start'> | null;

const networkx: Detector = (l, lang) =>
  lang === 'python' && /(^|\s)(import\s+networkx|from\s+networkx\s+import)\b/.test(l)
    ? { raw_name: 'networkx', topic_hint: 'dsa_graph_traversal', signal: 'networkx_import', confidence: 0.80 } : null;

const heap: Detector = (l, lang) => {
  if (lang === 'python' && /(^|\s)(import\s+heapq|from\s+heapq\s+import|from\s+queue\s+import\s+PriorityQueue)\b/.test(l))
    return { raw_name: 'heapq', topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 };
  if (lang === 'java' && /\bimport\s+java\.util\.PriorityQueue\b/.test(l))
    return { raw_name: 'PriorityQueue', topic_hint: 'dsa_heaps', signal: 'heap', confidence: 0.78 };
  return null;
};

const TREE_TYPES = /\b(class|interface|struct)\s+(TreeNode|BinaryTree|AVLTree|RedBlackTree|SegmentTree|TrieNode|Trie)\b/;
const treeType: Detector = (l) => {
  const m = TREE_TYPES.exec(l);
  if (!m) return null;
  const isTrie = /Trie/.test(m[2]);
  return { raw_name: m[2], topic_hint: isTrie ? 'dsa_tries' : 'dsa_trees', signal: 'tree_type', confidence: 0.75 };
};

const memoization: Detector = (l, lang) =>
  (lang === 'python' || lang === 'typescript' || lang === 'javascript') &&
  /^\s*@(functools\.)?(lru_cache|cache|memoize|memo)\b/.test(l)
    ? { raw_name: 'memoize', topic_hint: 'dsa_dynamic_programming', signal: 'memoization', confidence: 0.72 } : null;

const comparator: Detector = (l, lang) => {
  if ((lang === 'python') && /\.sort\(\s*key\s*=|(^|\W)sorted\([^)]*\bkey\s*=/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  if ((lang === 'java') && /Comparator\.(comparing|reverseOrder)|\.compare\s*\(/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  if ((lang === 'typescript' || lang === 'javascript') && /\.sort\(\s*\([^)]*\)\s*=>|\bcompareFn\b/.test(l))
    return { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 };
  return null;
};

const DETECTORS: Detector[] = [networkx, heap, treeType, memoization, comparator];

export function detectDsaPatterns(src: string, lang: DsaLang, filePath: string): RawDsaEvidence[] {
  const out: RawDsaEvidence[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const d of DETECTORS) {
      const hit = d(lines[i], lang);
      if (hit) out.push({ ...hit, file_path: filePath, line_start: i + 1 });
    }
  }
  return out;
}

export class DsaPatternExtractor {
  readonly name = 'dsa-pattern';
  constructor(
    private readonly readFile: (rel: string) => Promise<string>,
    private readonly files: string[],
  ) {}
  async extract(): Promise<RawDsaEvidence[]> {
    const out: RawDsaEvidence[] = [];
    for (const rel of this.files) {
      const lang = dsaLangForExt(rel.slice(rel.lastIndexOf('.')));
      if (!lang) continue;
      out.push(...detectDsaPatterns(await this.readFile(rel), lang, rel));
    }
    return out;
  }
}
```

- [ ] **Step 4: Run, verify pass.** Iterate regexes until both describe blocks pass. (Note: `xs.sort()` and bare `sorted(xs)` must NOT match — the comparator regex requires `key=` / arrow / `compareFn`.)
- [ ] **Step 5: Commit** — `feat(tech-extractor): DsaPatternExtractor — 5 high-precision DSA signals`

---

## Task 3: `DsaTopicResolver` + `RdsDsaEvidenceRepository` (TDD)

**Files:**
- Create: `applications/shared/src/stage-prep/dsa-evidence.ts`
- Test: `applications/shared/src/stage-prep/dsa-evidence.test.ts`

- [ ] **Step 1: Write failing tests** (fakePool mirrors existing repo tests):

```typescript
import { describe, it, expect, jest } from '@jest/globals';
import { DsaTopicResolver, RdsDsaEvidenceRepository } from './dsa-evidence.js';

describe('DsaTopicResolver', () => {
  const r = new DsaTopicResolver(new Set(['dsa_graph_traversal', 'dsa_heaps']));
  it('resolves a known canonical', () => expect(r.resolve('dsa_graph_traversal')).toBe('dsa_graph_traversal'));
  it('drops an unknown hint (never invents)', () => expect(r.resolve('dsa_made_up')).toBeNull());
});

describe('RdsDsaEvidenceRepository.insertMany', () => {
  it('sets user scope and inserts each row', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(client) } as any;
    const repo = new RdsDsaEvidenceRepository(pool);
    await repo.insertMany('u1', [
      { repoFullName: 'o/r', commitSha: 'sha', dsaTopic: 'dsa_heaps', signal: 'heap',
        rawName: 'heapq', filePath: 'h.py', lineStart: 1, confidence: 0.78 },
    ]);
    const sql = (query.mock.calls.map((c) => (c as unknown[])[0] as string));
    expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO dsa_evidence/.test(s))).toBe(true);
  });
  it('no-ops on empty', async () => {
    const pool = { connect: jest.fn() } as any;
    await new RdsDsaEvidenceRepository(pool).insertMany('u1', []);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `dsa-evidence.ts` (resolver + repo mirroring `TechnologyEvidenceRepository.insertMany`):

```typescript
/** @format */
import type { Pool } from 'pg';

export class DsaTopicResolver {
  constructor(private readonly valid: ReadonlySet<string>) {}
  /** @returns the canonical name if seeded in dsa_topics, else null (never invents). */
  resolve(topicHint: string): string | null { return this.valid.has(topicHint) ? topicHint : null; }
}

export interface DsaEvidenceRow {
  readonly repoFullName: string; readonly commitSha: string; readonly dsaTopic: string;
  readonly signal: string; readonly rawName: string; readonly filePath: string;
  readonly lineStart: number | null; readonly confidence: number;
}

export class RdsDsaEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async insertMany(userId: string, rows: DsaEvidenceRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      for (const r of rows) {
        await client.query(
          `INSERT INTO dsa_evidence (
             user_id, repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [userId, r.repoFullName, r.commitSha, r.dsaTopic, r.signal, r.rawName, r.filePath, r.lineStart, r.confidence],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listForRepo(userId: string, repoFullName: string): Promise<DsaEvidenceRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const { rows } = await client.query(
        `SELECT repo_full_name, commit_sha, dsa_topic, signal, raw_name, file_path, line_start, confidence
           FROM dsa_evidence WHERE user_id=$1::uuid AND repo_full_name=$2
          ORDER BY dsa_topic, file_path, line_start`, [userId, repoFullName]);
      await client.query('COMMIT');
      return rows.map((r: any) => ({ repoFullName: r.repo_full_name, commitSha: r.commit_sha,
        dsaTopic: r.dsa_topic, signal: r.signal, rawName: r.raw_name, filePath: r.file_path,
        lineStart: r.line_start, confidence: r.confidence }));
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
    finally { client.release(); }
  }
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(shared): DsaTopicResolver + RdsDsaEvidenceRepository (dsa_evidence lane)`

---

## Task 4: Wire DSA extraction into `run-tech-extract.ts` (fail-open)

**Files:**
- Modify: `applications/tech-extractor/src/run-tech-extract.ts` (after the orchestrator `run`, ~line 145+)

- [ ] **Step 1:** After the existing `orch.run(...)`, add a fail-open DSA block. It reuses `readFile`, `files`, `env.userId`, `env.repoFullName`, `sha`, and the already-open `pool` used for repositories:

```typescript
// ── DSA real-work pattern evidence (fail-open: never breaks tech-extract) ──
try {
  const dsaTopics = await new RdsDsaTopicRepository(pool).listTopics();
  const resolver = new DsaTopicResolver(new Set(dsaTopics.map((t) => t.canonicalName)));
  const raw = await new DsaPatternExtractor(readFile, files).extract();
  const rows = raw
    .map((e) => ({ canonical: resolver.resolve(e.topic_hint), e }))
    .filter((x) => x.canonical !== null)
    .map((x) => ({ repoFullName: env.repoFullName, commitSha: sha, dsaTopic: x.canonical as string,
      signal: x.e.signal, rawName: x.e.raw_name, filePath: x.e.file_path,
      lineStart: x.e.line_start, confidence: x.e.confidence }));
  await new RdsDsaEvidenceRepository(pool).insertMany(env.userId, rows);
  console.log(`[dsa] ${rows.length} real-work DSA evidence rows (from ${raw.length} raw matches)`);
} catch (err) {
  console.error('[dsa] extraction failed (non-fatal):', err);
}
```

Add imports: `DsaPatternExtractor` from `./extractors/DsaPatternExtractor.js`; `DsaTopicResolver`, `RdsDsaEvidenceRepository` + `RdsDsaTopicRepository` from the shared `stage-prep` barrel (match how the file imports other shared repos — verify the existing import style first).

- [ ] **Step 2:** Verify the `pool`/`readFile`/`files`/`sha` identifiers match the actual names in `run-tech-extract.ts` (read it first; adapt if named differently). Build: `npm run build -w applications/tech-extractor` (or the repo's tsc) → no type errors.
- [ ] **Step 3: Commit** — `feat(tech-extractor): persist DSA real-work evidence in run-tech-extract (fail-open)`

---

## Task 5: FP-gate audit harness (dev-only)

**Files:**
- Create: `applications/tech-extractor/src/extractors/dsa-fp-audit.ts`

- [ ] **Step 1:** A CLI that walks given repo dirs, runs `detectDsaPatterns` per file, prints CSV + total:

```typescript
/** @format */
// Usage: node dist/extractors/dsa-fp-audit.js <repoDir> [<repoDir> ...]
// Prints: repo,file:line,signal,raw_name,confidence  + a TOTAL line.
// MERGE GATE (manual): run over >=5 real repos, hand-inspect every match, require FP <= 5%.
import { promises as fs } from 'fs';
import * as path from 'path';
import { detectDsaPatterns, dsaLangForExt } from './DsaPatternExtractor.js';

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

async function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) { console.error('pass >=1 repo dir'); process.exit(1); }
  let total = 0;
  console.log('repo,location,signal,raw_name,confidence');
  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      if (!dsaLangForExt(path.extname(file))) continue;
      const lang = dsaLangForExt(path.extname(file))!;
      const src = await fs.readFile(file, 'utf-8').catch(() => '');
      for (const m of detectDsaPatterns(src, lang, path.relative(dir, file))) {
        total++;
        console.log(`${path.basename(dir)},${m.file_path}:${m.line_start},${m.signal},${m.raw_name},${m.confidence}`);
      }
    }
  }
  console.error(`TOTAL matches: ${total}`);
}
void main();
```

- [ ] **Step 2:** Build; smoke-run over the repo itself: `node dist/extractors/dsa-fp-audit.js .` → prints CSV + a TOTAL line to stderr. (No assertion test required — it's a dev tool; a lightweight test that `walk` skips node_modules is optional.)
- [ ] **Step 3: Commit** — `feat(tech-extractor): dsa-fp-audit harness for the FP<=5% merge gate`

---

## Final
- [ ] Run all suites: `npm test -w applications/tech-extractor` and `npm test -w applications/shared`.
- [ ] Dispatch final code-reviewer over the whole branch.
- [ ] superpowers:finishing-a-development-branch → PR. PR body MUST state: **the FP-gate audit is a manual pre-production step** (run `dsa-fp-audit` over ≥5 real repos, hand-inspect, require ≤5% FP; drop the weakest signal — comparator — first if exceeded), and that the 🟢/🟡 workspace lighting is the follow-up `tucaken-app` PR.
