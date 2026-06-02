# Comparator FP-Gate — Design

> **Date:** 2026-06-02 · **Status:** Approved design. Plan next.
> **Goal:** Stop the DSA `comparator` detector from firing on mundane web-app array sorts — it failed the FP≤5% merge gate at ~92% FP. Tighten it to fire only in an *algorithmic context*.
> **Repo:** `ai-applications` (single PR). **No migration.** **Branch:** `feat/comparator-fp-gate` off develop.

## Problem (from the FP-audit)

`dsa-fp-audit` over 5 repos (ai-applications, tucaken-app + TheAlgorithms/Java, keon/algorithms, trekhleb/javascript-algorithms) found the `comparator` signal at ~92% FP:

- The TS/JS branch `/\.sort\(\s*\([^)]*\)\s*=>/` fires on **every** web-app array sort — `items.sort((a,b)=>b.score-a.score)`, `.localeCompare`, multi-key tie-breaks. 131 mundane web sorts (ai-applications 82 + tucaken-app 49) vs 11 real algo-repo matches.
- The bare Python `.sort(key=`/`sorted(…key=` branch is similarly low-precision (any keyed sort).
- These are real Tier-1 *presence* but zero DSA competence → must not feed a 🟢 `dsa_sorting` badge.

The other 4 DSA signals (`heap`/`tree_type`/`memoization`/`networkx`) and the entire AI lane PASS at ~0% FP — out of scope here.

## Corpus-validated separation (load-bearing)

- **Authored-comparator markers** (`cmp_to_key`, `implements Comparator`, `implements Comparable`, `int compareTo(`) → **0 hits** across both web apps (excluding `.claude/`/`dist`/tests). Safe to fire path-independently.
- **Algo-context path regex** `/(algorithm|leetcode|dsa|kata|competitive|hackerrank|codewars|data[_-]?structures?)/i` → matches **11/11** algo-repo TP comparator paths (`thealgorithms/`, `algorithms/array/`, `data_structures/`, `src/algorithms/`), **0/131** web FP paths (`retrieval.ts`, `pii-scrubber.ts`, `computeUserProfileRollup.ts`…).

Combined, the tightening keeps 11/11 TP and drops 131/131 web FP → comparator FP `~92% → 0%`.

## Design

Single file: `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts` (+ its test). No schema/migration; emitted shape unchanged (`signal: 'comparator'`, `topic_hint: 'dsa_sorting'`, `confidence: 0.70`).

### 1. Thread `filePath` into detectors
Change the `Detector` type from `(l: string, lang: DsaLang) => …` to `(l: string, lang: DsaLang, filePath: string) => …`. `detectDsaPatterns` already holds `filePath` — pass it as the 3rd arg in the `d(lines[i], lang, filePath)` call. The other four detectors (`networkx`, `heap`, `treeType`, `memoization`) simply ignore the new parameter → zero behavior change for them.

### 2. `isAlgoContextPath(p)`
```ts
const ALGO_CONTEXT = /(algorithm|leetcode|dsa|kata|competitive|hackerrank|codewars|data[_-]?structures?)/i;
const isAlgoContextPath = (p: string): boolean => ALGO_CONTEXT.test(p);
```
Deliberately excludes a bare `sort` token (would match `assort`/`resort`/`sortKey.ts`); the algo-repo `sorting/` dirs already sit under `algorithms/` so they still match.

### 3. Rewrite `comparator`
Fires only when EITHER condition holds:

**(a) authored-comparator markers — any path** (near-zero web FP):
- Python: `\bcmp_to_key\b`
- Java: `\bimplements\s+Comparator\b` | `\bimplements\s+Comparable\b` | `\bint\s+compareTo\s*\(`

**(b) inline sort idioms — only if `isAlgoContextPath(filePath)`** (the existing patterns):
- Python: `\.sort\(\s*key\s*=` | `(^|\W)sorted\([^)]*\bkey\s*=`
- Java: `\bComparator\.(comparing|reverseOrder|thenComparing)\b` (adds `thenComparing`)
- TS/JS: `\.sort\(\s*\([^)]*\)\s*=>` | `\bcompareFn\b`

`__lt__`/`__gt__` dunders and bare `Comparator.comparing` outside an algo path are intentionally NOT path-independent markers (they appear on general value objects / Spring business code → FP risk).

## Honesty tradeoff (explicit)
A genuine custom comparator in a non-algo-named file *without* an impl marker — e.g. inline `.sort((a,b)=>)` in `src/twoSum.ts` — becomes a **false negative**. Accepted: the gate prioritizes precision (FP≤5%), and DSA-practice code conventionally lives in algorithm-named dirs. `dsa_sorting` remains available as a JD-calibration topic (`dsaTopicCalibration`) regardless of detected real-work evidence.

## Testing
`applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts`:

**Positives (must fire):**
- `from functools import cmp_to_key` line, path `app/util.py` (any path) → comparator.
- `class XComparator implements Comparator<Foo> {`, path `src/Main.java` → comparator.
- `public int compareTo(Foo o) {`, path `src/Foo.java` → comparator.
- `intervals.sort(key=lambda i: i.start)`, path `algorithms/array/merge_intervals.py` → comparator.
- `arr.sort((a, b) => a - b)`, path `src/algorithms/quicksort.ts` → comparator.

**Negatives (must emit nothing — the FP killers):**
- `items.sort((a, b) => b.score - a.score)`, path `src/retrieval.ts` → nothing.
- `rows.sort((a, b) => b.x - a.x || a.y - b.y)`, path `app/components/Dashboard.tsx` → nothing.
- `users.sort(key=lambda x: x.name)`, path `app/models.py` → nothing.

**Audit re-run:** `node dist/extractors/dsa-fp-audit.js` over the 5 repos → comparator FP ≤5% (expect 0%); the other 4 signals' counts unchanged.

## Out of scope
The other 4 DSA detectors (pass); the AI lane (passes); any UI/badge-gating logic; backfill of already-persisted `dsa_evidence` comparator rows (a later cleanup if needed — the detector fix stops new noise).
