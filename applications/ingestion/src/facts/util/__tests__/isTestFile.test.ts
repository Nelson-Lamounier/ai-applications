import { describe, it, expect } from '@jest/globals';
import { isTestFile } from '../isTestFile.js';

describe('isTestFile', () => {
  it.each([
    'applications/ingestion/src/facts/extractors/DsaPatternExtractor.test.ts',
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
