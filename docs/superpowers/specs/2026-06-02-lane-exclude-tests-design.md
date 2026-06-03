# Exclude Test Files from DSA + AI Lanes — Design

> **Date:** 2026-06-02 · **Status:** Approved design.
> **Goal:** Stop the DSA + AI real-work pattern lanes from scanning test/spec files. The live FP-gate verification (#127) showed the lanes scan `.test.` files while the audit harness skips them — so the detector matched its own `DsaPatternExtractor.test.ts` fixtures (7 self-match rows). Test-fixture matches are noise, not real-work evidence.
> **Repo:** `ai-applications` (single PR). **No migration.** **Branch:** `feat/lane-exclude-tests` off develop.

## Problem
`run-tech-extract.ts:148` builds one file list (`walkTextFiles`) shared by all lanes. The DSA (`:207`) and AI (`:232`) pattern lanes scan it including test files. A test file's fixtures (`class TreeNode`, `.sort((a,b)=>…)`, `cmp_to_key`, `implements Comparator`) trip the detectors, producing fake "real-work" rows. The `dsa-fp-audit` harness already excludes `.test.`/`.spec.` — the production lane must match.

## Scope decision
**DSA + AI lanes only.** The tech/IaC lane's claim is "declared X at file:line" — a real import in a test is still valid usage evidence, so it keeps the full list. Only the "real-work" lanes (DSA/AI) get the filtered list.

## Design

### A. `applications/tech-extractor/src/util/isTestFile.ts` (new, pure)
```ts
/** True for unit/integration test or mock files, across the langs the pattern lanes scan. */
export function isTestFile(rel: string): boolean { … }
```
Patterns (case-insensitive where sensible):
- **JS/TS:** `\.(test|spec)\.[mc]?[jt]sx?$`; path segment `__tests__/`; path segment `__mocks__/`
- **Python:** basename `test_*.py`; basename `*_test.py`; basename `conftest.py`
- **Java:** basename `*Test.java` / `*Tests.java`; path segment `/src/test/`

Language-specific (not a generic `/tests?/`) to avoid over-excluding real `test/` dirs that hold production code.

### B. `run-tech-extract.ts` — filtered list for the two pattern lanes
After `const files = await walkTextFiles(extractDir);` (line 148):
```ts
const patternFiles = files.filter((f) => !isTestFile(f));
```
Pass `patternFiles` to `new DsaPatternExtractor(readFile, patternFiles)` and `new AiPatternExtractor(readFile, patternFiles)`. Tech/IaC/Syft/TreeSitter lanes keep `files` unchanged.

## Testing
`applications/tech-extractor/src/util/isTestFile.test.ts`:
- **Positives:** `applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts`; `a/b/foo.spec.tsx`; `src/__tests__/x.ts`; `src/__mocks__/y.ts`; `pkg/test_merge.py`; `pkg/merge_test.py`; `conftest.py`; `com/x/FooTest.java`; `com/x/BarTests.java`; `src/test/java/com/x/Baz.java`.
- **Negatives (real src — must NOT match):** `applications/shared/src/retrieval.ts`; `algorithms/array/merge_intervals.py`; `src/algorithms/quicksort.ts`; `com/thealgorithms/sorts/QuickSort.java`; `src/contestPlatform.ts` (contains "test" substring but not a test file).

## Out of scope
Tech/IaC lane test exclusion; backfill of already-persisted rows (dev already cleaned; future scans won't re-add); changing the detectors themselves.
