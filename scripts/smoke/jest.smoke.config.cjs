/** @format */
// Unit tests for the smoke harness modules (mocked I/O, CI-safe) AND the
// per-flow *.smoke.test.ts suites (real infra, only via `just smoke-e2e`).
module.exports = {
  testEnvironment: 'node',
  rootDir: '..',                       // scripts/
  roots: ['<rootDir>/smoke'],
  testMatch: [
    '<rootDir>/smoke/__tests__/**/*.test.ts',
    '<rootDir>/smoke/**/*.smoke.test.ts',
  ],
  testTimeout: 10000,
  verbose: true,
  forceExit: true,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: false, tsconfig: '<rootDir>/smoke/tsconfig.json' },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
