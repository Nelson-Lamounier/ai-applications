# Exclude Test Files from DSA + AI Lanes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the DSA + AI pattern lanes from scanning test/spec files (the tech/IaC lane keeps scanning everything).

**Architecture:** A pure `isTestFile(rel)` util; `run-tech-extract` filters the walked file list with it and passes the filtered list to the DSA + AI extractors only.

**Tech Stack:** TypeScript (ESM), Jest. Spec: `docs/superpowers/specs/2026-06-02-lane-exclude-tests-design.md`. Branch `feat/lane-exclude-tests` off develop. NO `Co-Authored-By` trailer.

---

### Task 1: `isTestFile` pure util + tests

**Files:**
- Create: `applications/tech-extractor/src/util/isTestFile.ts`
- Test: `applications/tech-extractor/src/util/isTestFile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/tech-extractor/src/util/isTestFile.test.ts`:
```ts
import { describe, it, expect } from '@jest/globals';
import { isTestFile } from './isTestFile.js';

describe('isTestFile', () => {
  it.each([
    'applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts',
    'a/b/foo.spec.tsx',
    'a/b/foo.test.mjs',
    'src/__tests__/x.ts',
    'src/__mocks__/y.ts',
    'pkg/test_merge.py',
    'pkg/merge_test.py',
    'pkg/conftest.py',
    'com/x/FooTest.java',
    'com/x/BarTests.java',
    'src/test/java/com/x/Baz.java',
  ])('test file → true: %s', (p) => expect(isTestFile(p)).toBe(true));

  it.each([
    'applications/shared/src/retrieval.ts',
    'algorithms/array/merge_intervals.py',
    'src/algorithms/quicksort.ts',
    'com/thealgorithms/sorts/QuickSort.java',
    'src/contestPlatform.ts',
    'src/latest.py',
    'src/manifest.json',
  ])('real src → false: %s', (p) => expect(isTestFile(p)).toBe(false));
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd applications/tech-extractor && yarn test src/util/isTestFile.test.ts`
Expected: FAIL — module `./isTestFile.js` not found.

- [ ] **Step 3: Implement**

Create `applications/tech-extractor/src/util/isTestFile.ts`:
```ts
/** @format */
/**
 * True for unit/integration test or mock files, across the languages the DSA + AI
 * pattern lanes scan. Language-specific (no generic `/tests?/`) so real `test/` dirs
 * holding production code are not over-excluded.
 */
const PATTERNS: RegExp[] = [
  /\.(test|spec)\.[mc]?[jt]sx?$/i,   // JS/TS: foo.test.ts, foo.spec.tsx, foo.test.mjs
  /(^|\/)__tests__\//,               // JS/TS test dir
  /(^|\/)__mocks__\//,               // JS/TS mock dir
  /(^|\/)test_[^/]+\.py$/i,          // Python: test_foo.py
  /_test\.py$/i,                     // Python: foo_test.py
  /(^|\/)conftest\.py$/i,            // Python: pytest conftest
  /Tests?\.java$/,                   // Java: FooTest.java / FooTests.java
  /(^|\/)src\/test\//,               // Java (Maven/Gradle) test source root
];

export function isTestFile(rel: string): boolean {
  return PATTERNS.some((re) => re.test(rel));
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd applications/tech-extractor && yarn test src/util/isTestFile.test.ts`
Expected: PASS (all positives true, all negatives false).

- [ ] **Step 5: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git add applications/tech-extractor/src/util/isTestFile.ts applications/tech-extractor/src/util/isTestFile.test.ts
git commit -m "feat(tech-extractor): add isTestFile util for lane file filtering"
```

---

### Task 2: Wire `patternFiles` into the DSA + AI lanes

**Files:**
- Modify: `applications/tech-extractor/src/run-tech-extract.ts` (import; after line 148; the DSA extractor call ~line 207; the AI extractor call ~line 232)

- [ ] **Step 1: Add the import**

Near the other extractor imports (top of `run-tech-extract.ts`), add:
```ts
import { isTestFile } from './util/isTestFile.js';
```

- [ ] **Step 2: Build the filtered list**

Immediately after `const files = await walkTextFiles(extractDir);` (line 148), add:
```ts
        // DSA + AI "real-work" lanes must not score test fixtures (a test's `class TreeNode`
        // / `.sort((a,b)=>…)` / `cmp_to_key` is not real-work evidence). The tech/IaC lane
        // keeps the full list — a real import in a test is still valid "uses X" evidence.
        const patternFiles = files.filter((f) => !isTestFile(f));
```

- [ ] **Step 3: Pass `patternFiles` to the DSA extractor**

Change the DSA extractor construction (line ~207) from `new DsaPatternExtractor(readFile, files)` to:
```ts
                const raw = await new DsaPatternExtractor(readFile, patternFiles).extract();
```

- [ ] **Step 4: Pass `patternFiles` to the AI extractor**

Change the AI extractor construction (line ~232) from `new AiPatternExtractor(readFile, files)` to:
```ts
                const raw = await new AiPatternExtractor(readFile, patternFiles).extract();
```

(Leave `SyftExtractor`, `TreeSitterExtractor`, `iacExtractor` on the unfiltered `files`.)

- [ ] **Step 5: Typecheck/build**

Run: `cd applications/tech-extractor && yarn build`
Expected: tsc clean (no errors).

- [ ] **Step 6: Run the tech-extractor suite**

Run: `cd applications/tech-extractor && yarn test`
Expected: PASS (existing suites + the new `isTestFile` suite; nothing broken).

- [ ] **Step 7: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git add applications/tech-extractor/src/run-tech-extract.ts
git commit -m "fix(tech-extractor): exclude test files from DSA + AI lanes"
```

---

## Self-review checklist
- Spec coverage: isTestFile util (Task 1) + DSA/AI wiring (Task 2) + tech lane untouched ✓.
- No placeholders.
- Type consistency: `isTestFile(rel: string): boolean`, `patternFiles` used in both lane calls.
