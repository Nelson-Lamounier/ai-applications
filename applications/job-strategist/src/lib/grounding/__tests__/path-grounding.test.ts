/**
 * @format
 * Path-grounding verifier — pure unit tests.
 *
 * The Strategist agent can emit file-path citations (e.g.
 * `infra/lib/**\/*.ts`, `strategist-pipeline-stack.ts`). The text-level
 * BedrockGroundingVerifier confirms claim *content* against KB chunks but
 * does NOT check that a cited path actually exists in the ingested repo.
 * This catches the hallucinated-path class — e.g. `api/admin-api/src/**\/*.ts`
 * which the model inferred from prose but never appeared in document_embeddings.
 *
 * Fixtures below mirror the real cdk-monitoring ingestion (verified against
 * dev RDS document_embeddings on 2026-05-30).
 */
import { extractCitedPaths, isPathGrounded, classifyCitedPaths } from '../path-grounding.js';

// A representative slice of the file_path values actually ingested for
// Nelson-Lamounier/cdk-monitoring (top dirs: docs, infra, scripts, …).
const INGESTED = new Set<string>([
    'infra/lib/stacks/bedrock/strategist-pipeline-stack.ts',
    'infra/lib/aspects/cdk-nag-aspect.ts',
    'infra/lib/config/projects.ts',
    'infra/lib/constructs/compute/constructs/launch-template.ts',
    'docs/projects/admin-api.md',
    'docs/concepts/cicd-pipeline-architecture.md',
    'scripts/ci/preflight-checks.ts',
    'README.md',
]);

describe('extractCitedPaths', () => {
    it('extracts glob, bare-filename, and full-path citations from analysis prose', () => {
        const text =
            'TypeScript Production Engineering cdk-monitoring infra/lib/**/*.ts ' +
            '(all CDK constructs), api/admin-api/src/**/*.ts (Hono BFF), ' +
            'strategist-pipeline-stack.ts, all source files written in TypeScript 5.9';
        const paths = extractCitedPaths(text);
        expect(paths).toContain('infra/lib/**/*.ts');
        expect(paths).toContain('api/admin-api/src/**/*.ts');
        expect(paths).toContain('strategist-pipeline-stack.ts');
    });

    it('does NOT treat version numbers, abbreviations, or plain words as paths', () => {
        const text = 'Built with TypeScript 5.9 and aws-cdk-lib v2.130.0, e.g. strict mode, i.e. generics';
        const paths = extractCitedPaths(text);
        expect(paths).toEqual([]);
    });

    it('strips trailing punctuation and parenthetical annotations', () => {
        const text = 'see infra/lib/config/projects.ts, and docs/projects/admin-api.md.';
        const paths = extractCitedPaths(text);
        expect(paths).toContain('infra/lib/config/projects.ts');
        expect(paths).toContain('docs/projects/admin-api.md');
        // no token should carry a trailing comma or period
        expect(paths.every((p: string) => !/[.,]$/.test(p))).toBe(true);
    });

    it('dedupes repeated citations', () => {
        const text = 'infra/lib/**/*.ts and again infra/lib/**/*.ts';
        expect(extractCitedPaths(text)).toEqual(['infra/lib/**/*.ts']);
    });
});

describe('isPathGrounded', () => {
    it('grounds an exact ingested path', () => {
        expect(isPathGrounded('infra/lib/aspects/cdk-nag-aspect.ts', INGESTED)).toBe(true);
    });

    it('grounds a glob whose non-glob prefix + extension matches a real path', () => {
        expect(isPathGrounded('infra/lib/**/*.ts', INGESTED)).toBe(true);
    });

    it('grounds a bare filename by basename match', () => {
        expect(isPathGrounded('strategist-pipeline-stack.ts', INGESTED)).toBe(true);
    });

    it('does NOT ground a glob whose prefix never appears in the ingested set', () => {
        // The real admin-api lives in tucaken-app, not in cdk-monitoring.
        expect(isPathGrounded('api/admin-api/src/**/*.ts', INGESTED)).toBe(false);
    });

    it('does NOT ground an invented full path', () => {
        expect(isPathGrounded('src/services/foo-bar.ts', INGESTED)).toBe(false);
    });

    it('does NOT ground a bare filename with no basename match', () => {
        expect(isPathGrounded('nonexistent-module.ts', INGESTED)).toBe(false);
    });
});

describe('classifyCitedPaths', () => {
    it('splits the sample analysis into grounded vs ungrounded', () => {
        const text =
            'cdk-monitoring infra/lib/**/*.ts (all CDK constructs), ' +
            'api/admin-api/src/**/*.ts (Hono BFF), strategist-pipeline-stack.ts';
        const { grounded, ungrounded } = classifyCitedPaths(text, INGESTED);
        expect(grounded).toEqual(
            expect.arrayContaining(['infra/lib/**/*.ts', 'strategist-pipeline-stack.ts']),
        );
        expect(ungrounded).toEqual(['api/admin-api/src/**/*.ts']);
    });

    it('returns empty arrays when no paths are cited', () => {
        expect(classifyCitedPaths('No paths here, just prose.', INGESTED)).toEqual({
            grounded: [],
            ungrounded: [],
        });
    });

    it('treats everything as grounded when the ingested set is empty only if no paths cited', () => {
        // Empty ingested set: any cited path is ungrounded (nothing to match).
        const { grounded, ungrounded } = classifyCitedPaths('infra/lib/x.ts', new Set<string>());
        expect(grounded).toEqual([]);
        expect(ungrounded).toEqual(['infra/lib/x.ts']);
    });
});
