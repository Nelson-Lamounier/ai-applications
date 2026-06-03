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
