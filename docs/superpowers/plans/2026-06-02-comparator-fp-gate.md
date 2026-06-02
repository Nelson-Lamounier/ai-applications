# Comparator FP-Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the DSA `comparator` detector so it fires only in an algorithmic context, dropping the ~92% false-positive web-app array-sort matches that failed the FP≤5% merge gate.

**Architecture:** Thread the already-available `filePath` into each `Detector`, then rewrite `comparator` to emit only on (a) authored-comparator markers (path-independent: `cmp_to_key`, `implements Comparator/Comparable`, `int compareTo(`) OR (b) the existing inline-sort idioms *gated* behind an algorithm-named path. Pure functions, line-based, no schema/migration.

**Tech Stack:** TypeScript (ESM), Jest (ts-jest via `../../jest.config.base.cjs`), the `dsa-fp-audit` CLI harness over `dist/`.

**Spec:** `docs/superpowers/specs/2026-06-02-comparator-fp-gate-design.md`
**Branch:** `feat/comparator-fp-gate` (off develop, already created).
**Commits:** NO `Co-Authored-By` trailer.

---

### Task 1: Thread `filePath` into the `Detector` signature (safe refactor)

**Files:**
- Modify: `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts:20` (Detector type) and `:69` (call site)
- Test: `applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts` (existing suite — must stay green)

This is a no-behavior-change refactor: the 4 other detectors keep their 2-arg arrow signatures (TypeScript structural typing allows a 2-param function to satisfy a 3-param type), and `comparator` will start using the 3rd arg in Task 2.

- [ ] **Step 1: Run the existing suite to establish a green baseline**

Run: `cd applications/tech-extractor && yarn jest src/extractors/DsaPatternExtractor.test.ts`
Expected: PASS (all existing tests green) — confirms starting state before refactor.

- [ ] **Step 2: Change the `Detector` type to take `filePath`**

In `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts`, replace line 20:

```ts
// Each detector returns matches for ONE line. Keep patterns sufficient-not-necessary.
type Detector = (line: string, lang: DsaLang, filePath: string) => Omit<RawDsaEvidence, 'file_path' | 'line_start'> | null;
```

- [ ] **Step 3: Pass `filePath` at the call site**

In the same file, in `detectDsaPatterns`, replace the detector call (line 69):

```ts
      const hit = d(lines[i], lang, filePath);
```

(Leave `networkx`, `heap`, `treeType`, `memoization` unchanged — they ignore the new 3rd argument.)

- [ ] **Step 4: Run the suite — still green**

Run: `cd applications/tech-extractor && yarn jest src/extractors/DsaPatternExtractor.test.ts`
Expected: PASS (identical results to Step 1 — pure refactor, no behavior change).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/DsaPatternExtractor.ts
git commit -m "refactor(tech-extractor): thread filePath into Detector signature"
```

---

### Task 2: Rewrite `comparator` — impl-markers any-path OR inline-sort in algo-context path

**Files:**
- Modify: `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts:51-60` (the `comparator` detector; add helper above it)
- Test: `applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts` (update test 5; add positives + FP-killer negatives)

- [ ] **Step 1: Write the failing tests**

In `applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts`:

First, **update existing test 5** (line 29-32) — an inline keyed sort must now live in an algo-context path to fire:

```ts
  it('5. inline sort in an algo-context path → dsa_sorting @0.70', () => {
    expect(detectDsaPatterns('xs.sort(key=lambda x: x.cost)\n', 'python', 'algorithms/greedy/s.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 });
  });
```

Then **add a new describe block** at the end of the file:

```ts
describe('detectDsaPatterns — comparator FP-gate (2026-06-02)', () => {
  // (a) Authored-comparator markers fire regardless of path (≈0 web FP).
  it('python cmp_to_key (any path) → comparator', () => {
    expect(detectDsaPatterns('ys = sorted(xs, key=cmp_to_key(mycmp))\n', 'python', 'util.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 });
  });
  it('java implements Comparator (any path) → comparator', () => {
    expect(detectDsaPatterns('class ByAge implements Comparator<P> {\n', 'java', 'Main.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java implements Comparable (any path) → comparator', () => {
    expect(detectDsaPatterns('public class P implements Comparable<P> {\n', 'java', 'P.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java compareTo override (any path) → comparator', () => {
    expect(detectDsaPatterns('    public int compareTo(P o) { return 0; }\n', 'java', 'P.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });

  // (b) Inline sort idioms fire ONLY in an algorithm-named path.
  it('python inline keyed sort in algorithms/ path → comparator', () => {
    expect(detectDsaPatterns('intervals.sort(key=lambda i: i.start)\n', 'python', 'algorithms/array/merge_intervals.py')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('ts inline comparator in src/algorithms path → comparator', () => {
    expect(detectDsaPatterns('arr.sort((a, b) => a - b)\n', 'typescript', 'src/algorithms/quicksort.ts')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });
  it('java Comparator.thenComparing in data_structures path → comparator', () => {
    expect(detectDsaPatterns('Comparator.comparing(P::a).thenComparing(P::b);\n', 'java', 'data_structures/Heap.java')[0])
      .toMatchObject({ topic_hint: 'dsa_sorting', signal: 'comparator' });
  });

  // FP killers — the web-app sorts that broke the gate now emit NOTHING.
  it('NEGATIVE: ts web sort in src/retrieval.ts → nothing', () => {
    expect(detectDsaPatterns('items.sort((a, b) => b.score - a.score)\n', 'typescript', 'src/retrieval.ts')).toEqual([]);
  });
  it('NEGATIVE: ts multi-key web sort in a component → nothing', () => {
    expect(detectDsaPatterns('rows.sort((a, b) => b.x - a.x || a.y - b.y)\n', 'typescript', 'app/components/Dashboard.tsx')).toEqual([]);
  });
  it('NEGATIVE: python keyed sort in a non-algo path → nothing', () => {
    expect(detectDsaPatterns('users.sort(key=lambda x: x.name)\n', 'python', 'app/models.py')).toEqual([]);
  });
  it('NEGATIVE: bare Comparator.comparing outside algo path → nothing', () => {
    expect(detectDsaPatterns('users.sort(Comparator.comparing(User::getName));\n', 'java', 'src/UserService.java')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `cd applications/tech-extractor && yarn jest src/extractors/DsaPatternExtractor.test.ts`
Expected: FAIL — the new positives in non-algo paths currently fire (old behavior), the new FP-killer negatives currently match (old behavior), and updated test 5 may pass for the wrong reason; the impl-marker positives (`cmp_to_key`/`implements`/`compareTo`) FAIL because the current detector doesn't match them.

- [ ] **Step 3: Implement the gated comparator**

In `applications/tech-extractor/src/extractors/DsaPatternExtractor.ts`, replace the whole `comparator` detector (lines 51-60) with the helper + rewrite:

```ts
// A file path that looks like deliberate algorithmic work (DSA-practice dirs). Bare `sort`
// is excluded (would match assort/resort/sortKey); algo `sorting/` dirs sit under `algorithms/`.
const ALGO_CONTEXT = /(algorithm|leetcode|dsa|kata|competitive|hackerrank|codewars|data[_-]?structures?)/i;
const isAlgoContextPath = (p: string): boolean => ALGO_CONTEXT.test(p);

const SORTING_HIT = { raw_name: 'comparator', topic_hint: 'dsa_sorting', signal: 'comparator', confidence: 0.70 } as const;

// FP-gate (2026-06-02): a bare `.sort((a,b)=>…)` / `.sort(key=…)` is ubiquitous in web code
// (~92% FP in the audit). Fire only on (a) an authored-comparator marker — any path — or
// (b) an inline sort idiom located in an algorithm-named file.
const comparator: Detector = (l, lang, filePath) => {
  // (a) authored-comparator markers — path-independent (≈0 web FP).
  if (lang === 'python' && /\bcmp_to_key\b/.test(l)) return SORTING_HIT;
  if (lang === 'java' && /\bimplements\s+Comparator\b|\bimplements\s+Comparable\b|\bint\s+compareTo\s*\(/.test(l))
    return SORTING_HIT;

  // (b) inline sort idioms — only in an algorithmic-context file.
  if (!isAlgoContextPath(filePath)) return null;
  if (lang === 'python' && /\.sort\(\s*key\s*=|(^|\W)sorted\([^)]*\bkey\s*=/.test(l)) return SORTING_HIT;
  if (lang === 'java' && /\bComparator\.(comparing|reverseOrder|thenComparing)\b/.test(l)) return SORTING_HIT;
  if ((lang === 'typescript' || lang === 'javascript') && /\.sort\(\s*\([^)]*\)\s*=>|\bcompareFn\b/.test(l))
    return SORTING_HIT;
  return null;
};
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `cd applications/tech-extractor && yarn jest src/extractors/DsaPatternExtractor.test.ts`
Expected: PASS (all positives, all FP-killer negatives, and the rest of the original suite — `tree_type`, `heap`, `memoization`, `networkx`, the Java `VersionUtil.compare` negative, etc. — green).

- [ ] **Step 5: Commit**

```bash
git add applications/tech-extractor/src/extractors/DsaPatternExtractor.ts applications/tech-extractor/src/extractors/DsaPatternExtractor.test.ts
git commit -m "fix(tech-extractor): gate comparator to algorithmic context (FP-audit)"
```

---

### Task 3: Verify the FP gate via `dsa-fp-audit` over 5 repos

**Files:**
- Build output: `applications/tech-extractor/dist/` (via `yarn build`)
- No source changes — this is the merge-gate verification.

- [ ] **Step 1: Build dist (the audit harness runs compiled JS)**

Run: `cd applications/tech-extractor && yarn build`
Expected: tsc completes with no errors; `dist/extractors/DsaPatternExtractor.js` + `dist/extractors/dsa-fp-audit.js` updated.

- [ ] **Step 2: Clone the 3 DSA reference repos (shallow)**

```bash
cd /tmp && rm -rf fp-audit && mkdir fp-audit && cd fp-audit
git clone --depth 1 -q https://github.com/TheAlgorithms/Java.git java-algos
git clone --depth 1 -q https://github.com/keon/algorithms.git py-algos
git clone --depth 1 -q https://github.com/trekhleb/javascript-algorithms.git js-algos
```
Expected: three repos cloned under `/tmp/fp-audit/`.

- [ ] **Step 3: Run the audit over all 5 repos (3 DSA + 2 local web apps)**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/applications/tech-extractor
node dist/extractors/dsa-fp-audit.js \
  /tmp/fp-audit/java-algos /tmp/fp-audit/py-algos /tmp/fp-audit/js-algos \
  /Users/nelsonlamounier/Desktop/portfolio/ai-applications \
  /Users/nelsonlamounier/Desktop/portfolio/tucaken-app \
  > /tmp/dsa-audit-after.csv 2>/tmp/dsa-audit-after.total
```

Then count comparator matches in the two web apps, excluding `.claude/`/`dist`/tests:

```bash
tail -n +2 /tmp/dsa-audit-after.csv | \
  awk -F, '($1=="ai-applications"||$1=="tucaken-app") && $3=="comparator" {print $2}' | \
  grep -vE '/\.claude/|/dist/|\.test\.|\.spec\.' | wc -l
```
Expected: `0` (was 131 before the fix). FP rate for `comparator` → 0% ≤ 5% gate.

- [ ] **Step 4: Confirm the 4 other signals + algo-repo comparator TPs are unchanged**

```bash
tail -n +2 /tmp/dsa-audit-after.csv | \
  awk -F, '$2 !~ /\.claude\/|\/dist\/|\.test\.|\.spec\./ {print $1","$3}' | sort | uniq -c | sort -rn
```
Expected: `heap` (java 18 + py 8), `tree_type` (java 12 + py 7 + js 4), `memoization` (py 1) unchanged; `comparator` now only in the algo repos (py/java/js ~11 total), **zero** in `ai-applications`/`tucaken-app`.

- [ ] **Step 5: Record the gate result in memory + clean up**

Update `~/.claude/projects/-Users-nelsonlamounier-Desktop-portfolio-ai-applications/memory/e2e-fp-audit-findings.md`: note the comparator gate now PASSES (FP 0%) after `feat/comparator-fp-gate`. Then:

```bash
rm -rf /tmp/fp-audit
```
(No commit — verification + memory only.)

---

## Notes for the implementer
- ESM imports use `.js` suffixes even for `.ts` files — keep `from './DsaPatternExtractor.js'` in the test.
- The 4 untouched detectors satisfy the new 3-arg `Detector` type by structural typing — do NOT add unused `filePath` params to them.
- `dsa_sorting` remains a JD-calibration topic (`dsaTopicCalibration`) regardless of this detector — do not touch `dsa_topics` / calibration code.
- Already-persisted `dsa_evidence` comparator rows are out of scope (detector fix stops new noise; backfill is a separate cleanup if ever needed).
