/**
 * @format
 * Jest Configuration — Integration Tests (Step Functions TestState API)
 *
 * Separate config for tests that call real AWS APIs (TestState).
 * These tests require AWS credentials and TEST_SFN_ROLE_ARN to be set.
 *
 * Unit tests use jest.config.js (excludes tests/integration/).
 * This config covers only tests/integration/.
 *
 * Usage:
 *   just test-sfn                                     # all integration tests
 *   just test-sfn --testPathPattern="article"         # filtered
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    // ── Transform ────────────────────────────────────────────────────────
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                // isolatedModules speeds up compilation — no type-checking here
                // (typecheck job handles that separately)
                isolatedModules: true,
            },
        ],
    },

    // ── Test Discovery ───────────────────────────────────────────────────
    testMatch: ['**/tests/integration/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk\\.out/'],

    // ── Timeouts ─────────────────────────────────────────────────────────
    // TestState API calls real AWS — each call ~1–3 s; CDK synthesis ~5–10 s
    testTimeout: 60_000,

    // ── Setup ────────────────────────────────────────────────────────────
    // esbuild mock (spawnSync interception) required for CDK synthesis in helpers
    setupFiles: ['<rootDir>/tests/jest-worker-setup.js'],

    // ── Environment ──────────────────────────────────────────────────────
    testEnvironment: 'node',

    verbose: true,
};
