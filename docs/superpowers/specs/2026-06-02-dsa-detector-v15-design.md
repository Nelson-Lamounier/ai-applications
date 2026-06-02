# DSA Real-Work Pattern Detector — Design (v1.5)

> **Date:** 2026-06-02
> **Status:** Approved design (fork ratified by user: dedicated evidence lane). Plan next.
> **Goal:** Surface the *rare* real-work code patterns that honestly map to DSA topics, so the
> Technical workspace can show 🟢 "your `graph.py:42` imports networkx" evidence — WITHOUT
> becoming a practice platform and WITHOUT a single false "your work shows X".
> **Builds on:** DSA v1 (`dsa_topics` 051, `dsaTopicCalibration`, Technical Section B).
> **Design input:** `docs/superpowers/specs/2026-06-01-dsa-support-design-input.md` §3.
> **Repos:** `ai-applications` (this spec — detector + evidence lane). Lighting the 🟢 badges in
> the Technical workspace is a **follow-up PR** in `tucaken-app` (consumes `dsa_evidence`).

## The two adversarial verdicts carried as hard constraints

1. **Minimal high-precision, NOT the 15-regex set.** A signal is admissible ONLY if a human can
   open the linked `file:line` and confirm DSA *intent* with zero semantic inference — the match
   must be a *sufficient* condition, not merely necessary. (The repo's own decommission report set
   the bar: 0–2.5% FP across 120 hand-inspected rows; a 15-regex set would regress to ~10–20%.)
2. **DSA = concept, never installable technology.** Evidence lands in a **dedicated `dsa_evidence`
   lane** — it never enters `technology_ontology` / `technology_evidence`, so the skill-graph and
   KB-quality consumers are completely unaffected. (User-ratified fork, 2026-06-02.)

## The 5 admissible detectors (the ONLY signals v1.5 emits)

| # | Signal | Pattern | Lang | Confidence | Why honest (sufficient, not just necessary) |
|---|---|---|---|---|---|
| 1 | Graph algorithms | `import networkx` / `from networkx` (used) | Python | 0.80 | networkx is a dedicated graph library — importing it *is* declarative intent |
| 2 | Heap / priority queue | `import heapq`, `from heapq import`, `from queue import PriorityQueue`, `java.util.PriorityQueue` | Py / Java | 0.78 | Dedicated priority-queue construct, not a generic loop |
| 3 | Tree / trie structures | explicit type def `class TreeNode`, `class BinaryTree`, `class TrieNode`, `class SegmentTree` (also TS `interface`/`type`) | Py / TS / Java | 0.75 | Author *named* a DSA type — explicit authoring intent |
| 4 | Memoization (declarative) | `@functools.lru_cache`, `@lru_cache`, `@cache`, `@memoize` / `@memo` decorator | Py / TS | 0.72 | The decorator name *is* the stated intent |
| 5 | Custom comparator sort | `sorted(..., key=...)`, `.sort(key=...)`, `Comparator.comparing`/`.compare(`, explicit `compareFn`/`comparator` arg | Py / Java / TS | 0.70 | Explicit comparator authoring (weakest — keep ≤0.70) |

Each maps to a `dsa_topics.canonical_name` that is **verified present in the 051 seed**:
1→`dsa_graph_traversal`, 2→`dsa_heaps`, 3→`dsa_trees` (and `TrieNode`/`SegmentTree`→`dsa_tries`),
4→`dsa_dynamic_programming`, 5→`dsa_sorting`. The resolver maps only to canonicals that exist in
`dsa_topics` — a hint that resolves to nothing is **dropped**, never invented.

## What we EXPLICITLY do NOT detect (necessary-not-sufficient → dishonest)

Enforced by **negative unit tests** (each must yield zero evidence):
- ❌ Sliding window via `for … range … len` / `[i:i+k]` slicing — matches any windowed/pagination loop
- ❌ "DP" via `dp[]` / nested loops — matches any 2D array iteration
- ❌ Recursion via "function calls itself" — matches FS traversal, JSON unmarshalling, GUI render
- ❌ Generic `deque` / `Queue` / `collections.deque` as "graph traversal" — usually a message/work queue
- ❌ Generic stack via `list.append`/`pop`, set ops, rate-limiting, retry/backoff, pagination

## Components (all in `ai-applications`)

### A. `dsa_evidence` table — migration `054_dsa_evidence.sql`
RLS-protected per user (mirrors `technology_evidence`'s RLS), but **standalone** — FK to
`dsa_topics(canonical_name)`, NOT to `technology_ontology`:
```sql
CREATE TABLE IF NOT EXISTS dsa_evidence (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_full_name      TEXT NOT NULL,
  commit_sha          TEXT NOT NULL,
  dsa_topic           TEXT NOT NULL REFERENCES dsa_topics(canonical_name),
  signal              TEXT NOT NULL,          -- which detector fired: 'networkx_import' | 'heap' | 'tree_type' | 'memoization' | 'comparator'
  raw_name            TEXT NOT NULL,          -- the matched token, e.g. 'networkx'
  file_path           TEXT NOT NULL,
  line_start          INT,
  confidence          REAL NOT NULL,          -- per-signal (0.70–0.80)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- + RLS enable + policy USING (user_id = current_setting('app.current_user_id')::uuid), mirroring 034.
-- + index on (user_id, repo_full_name).
```
No change to `techgraph.ts`, `CONFIDENCE_BY_LAYER`, or the `technology_evidence` CHECK.

### B. `DsaPatternExtractor` (`applications/tech-extractor/src/extractors/DsaPatternExtractor.ts`)
Mirrors `TreeSitterExtractor`'s shape — constructor `(readFile, files)` — but emits its OWN type
(does NOT implement the shared `Extractor` interface, since it bypasses the tech orchestrator):
```typescript
export interface RawDsaEvidence {
  readonly raw_name: string;      // matched token e.g. 'networkx'
  readonly topic_hint: string;    // 'dsa_graphs' — resolver validates against dsa_topics
  readonly signal: string;        // 'networkx_import' | 'heap' | 'tree_type' | 'memoization' | 'comparator'
  readonly confidence: number;    // per-signal 0.70–0.80
  readonly file_path: string;
  readonly line_start: number;    // 1-indexed
}
export function detectDsaPatterns(src: string, lang: Lang, filePath: string): RawDsaEvidence[]
export class DsaPatternExtractor { constructor(readFile, files); extract(): Promise<RawDsaEvidence[]> }
```
Each of the 5 detectors is a pure function tested with inline-string fixtures (repo convention).
`detectDsaPatterns` dispatches by `lang` (reuse `langForExt`). Reports `file_path` + 1-indexed
`line_start` for the honest deep-link.

### C. `DsaTopicResolver` (`applications/shared/src/stage-prep/dsa-evidence.ts`)
Mirrors `OntologyResolver` discipline (can't invent): constructed from the set of valid
`dsa_topics.canonical_name`; `resolve(topicHint): string | null` returns the canonical or null
(→ caller drops it). Loaded once per job from `RdsDsaTopicRepository`.

### D. `RdsDsaEvidenceRepository` (`applications/shared/src/stage-prep/dsa-evidence.ts`)
`insertMany(userId, rows: DsaEvidenceRow[])` (sets `app.current_user_id` like the tech repos) and
`listForRepo(userId, repoFullName)` / `listForUser(userId)` (for the future workspace + tests).

### E. Wire into `run-tech-extract.ts`
After the existing orchestrator run (reuses the already-discovered `files` + `readFile` + `userId`
/`repoFullName`/`sha` — **no new K8s job**): run `DsaPatternExtractor.extract()` →
`DsaTopicResolver.resolve` each (drop unresolved) → `RdsDsaEvidenceRepository.insertMany`.
Fail-open: a DSA-extraction error logs + continues (never breaks the tech-extract job).

### F. FP-gate audit harness (`applications/tech-extractor/src/extractors/dsa-fp-audit.ts`)
A dev-only script: run `detectDsaPatterns` over a list of local repo paths, print every match as
`repo,file:line,signal,raw_name,confidence` (CSV). **Merge gate (manual, documented):** before
enabling in production, run over ≥5 real repos, hand-inspect every match, require **FP ≤ 5%**.
If a signal exceeds the budget, drop that signal (start with comparator, the weakest). Honest
logging: the script prints the total match count so silent under-coverage is visible.

## Data flow
```
run-tech-extract job (existing): discover files, readFile
  → [unchanged] tech orchestrator → technology_evidence
  → [NEW] DsaPatternExtractor.detectDsaPatterns(src, lang, path) per file
       → DsaTopicResolver.resolve(topic_hint)  (drop if not in dsa_topics)
       → RdsDsaEvidenceRepository.insertMany → dsa_evidence (RLS per user)
(future tucaken-app PR) admin-api joins dsa_evidence × dsaTopicCalibration
  → Technical Section B lights 🟢 (real-work) on calibrated topics, with the file:line deep-link
```

## Error handling & honesty guardrails
- A `topic_hint` not present in `dsa_topics` is **dropped** (resolver returns null) — never invented.
- Every row carries `file_path` + `line_start` → the UI deep-link lets a human confirm intent
  (the honest-evidence test). No file:line → not emitted.
- Per-signal confidence (0.70–0.80) stored verbatim; nothing claims certainty.
- The do-NOT-detect list is enforced by negative tests; adding a necessary-not-sufficient signal
  is a spec violation.
- `dsa_evidence` is RLS-isolated and feeds ONLY the Technical workspace — never the skill-graph,
  KB-quality scoring, or `technology_evidence`.
- DSA extraction is fail-open (its failure never breaks tech-extract).

## Testing
- **B (detectors):** each of the 5 → positive inline fixtures (emits, right topic_hint + confidence
  + line_start); the do-NOT-detect list → negative fixtures (emit nothing). Multi-line `line_start`
  correctness. `detectDsaPatterns` dispatches by lang.
- **C (resolver):** valid hint → canonical; unknown hint → null.
- **D (repo):** `insertMany` sets user scope + inserts N rows (fakePool); `listForRepo` round-trips.
- **A (migration):** applies; FK to `dsa_topics` holds; RLS policy present.
- **E (wiring):** DSA evidence persisted after a run; an extractor throw does not fail the job.
- **F (audit):** script runs over a fixture dir and prints CSV + total count.

## Decomposition
- **PR1 (this spec, `ai-applications`):** migration 054 + `DsaPatternExtractor` (5 detectors +
  negative tests) + `DsaTopicResolver` + `RdsDsaEvidenceRepository` + `run-tech-extract` wiring +
  FP-audit harness.
- **PR2 (follow-up, `tucaken-app`):** admin-api serves `dsa_evidence`; Technical Section B lights
  🟢/🟡 real-work badges (merging real-work evidence with the existing 🔴 JD-calibration cards).
  Gated on PR1's FP-audit passing ≤5%.

## Out of scope
- The 15-regex detector set; any semantic/AST DSA inference; practice-problem generation, mock
  interviews, tutoring, LeetCode API; DSA content tables. (All remain deferred indefinitely.)
