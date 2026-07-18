/**
 * @format
 * run-tech-extract — commit-sha resolution + the "never literal HEAD"
 * persist invariant (P2 Task 4, Fix A).
 *
 * `resolveHeadSha` and `resolveShaOrRefuse` are the two testable seams of
 * `fetchAndExtractTarball` / `main`'s sha-resolution flow. `main()` itself is
 * a K8s Job entrypoint with a `require.main === module` guard (mirrors
 * run-ingestion.ts), so importing this module for its exports is
 * side-effect-free — `bootstrapK8sObservability` is a process-wide singleton
 * cached on `globalThis.__obsHandle`, so calling it here BEFORE requiring
 * `run-tech-extract.js` and spying on the returned logger observes the exact
 * same instance `resolveShaOrRefuse` logs through.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { bootstrapK8sObservability } from '@bedrock/shared';
import type * as RunTechExtractModule from './run-tech-extract.js';
import type { TechExtractEnv } from './env-tech-extract.js';

const obs = bootstrapK8sObservability({ serviceName: 'run-tech-extract-test' });
const infoSpy = jest.spyOn(obs.logger, 'info').mockImplementation(() => obs.logger);
const errorSpy = jest.spyOn(obs.logger, 'error').mockImplementation(() => obs.logger);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveHeadSha, resolveShaOrRefuse } = require('./run-tech-extract.js') as typeof RunTechExtractModule;

const SHA_40_HEX = '2c9dacce1d3cf5ffd722b2a28021692023dea548';

function makeEnv(over: Partial<TechExtractEnv> = {}): TechExtractEnv {
    return {
        userId:       'user-1',
        repoFullName: 'octo/repo',
        githubToken:  'gh-token',
        forceReindex: false,
        workDir:      '/work',
        pg: { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
        ...over,
    };
}

describe('resolveHeadSha', () => {
    it('prefers the codeload-resolved sha when present', () => {
        expect(resolveHeadSha('resolved-sha', `octo-repo-${SHA_40_HEX}`)).toBe('resolved-sha');
    });

    it('falls back to the tarball root-dir sha suffix when the codeload parse is undefined', () => {
        expect(resolveHeadSha(undefined, `octo-repo-${SHA_40_HEX}`)).toBe(SHA_40_HEX);
    });

    it('returns undefined when neither source resolves (short/absent root dir)', () => {
        expect(resolveHeadSha(undefined, 'octo-repo-main')).toBeUndefined();
        expect(resolveHeadSha(undefined, null)).toBeUndefined();
    });
});

describe('resolveShaOrRefuse', () => {
    beforeEach(() => {
        infoSpy.mockClear();
        errorSpy.mockClear();
    });

    it('returns env.commitSha outright when set, without touching the tarball result', () => {
        const env = makeEnv({ commitSha: 'explicit-sha' });

        const sha = resolveShaOrRefuse(env, { resolvedSha: undefined, rootDir: null });

        expect(sha).toBe('explicit-sha');
        expect(infoSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('resolves via the codeload-parsed sha and logs tech-extract.resolved-head-sha', () => {
        const env = makeEnv();

        const sha = resolveShaOrRefuse(env, { resolvedSha: 'resolved-sha', rootDir: `octo-repo-${SHA_40_HEX}` });

        expect(sha).toBe('resolved-sha');
        expect(infoSpy).toHaveBeenCalledWith(
            expect.objectContaining({ repo: 'octo/repo', sha: 'resolved-sha' }),
            'tech-extract.resolved-head-sha',
        );
    });

    it('root-dir fallback works: resolves via the tarball root-dir sha suffix when codeload parse failed', () => {
        const env = makeEnv();

        const sha = resolveShaOrRefuse(env, { resolvedSha: undefined, rootDir: `octo-repo-${SHA_40_HEX}` });

        expect(sha).toBe(SHA_40_HEX);
        expect(infoSpy).toHaveBeenCalledWith(
            expect.objectContaining({ repo: 'octo/repo', sha: SHA_40_HEX }),
            'tech-extract.resolved-head-sha',
        );
    });

    it('unresolvable: returns undefined (caller skips persist) and logs loudly instead of stamping HEAD', () => {
        const env = makeEnv();

        const sha = resolveShaOrRefuse(env, { resolvedSha: undefined, rootDir: 'octo-repo-main' });

        expect(sha).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ repo: 'octo/repo', rootDir: 'octo-repo-main' }),
            expect.stringContaining('tech-extract.unresolved-sha'),
        );
        expect(infoSpy).not.toHaveBeenCalled();
    });

    it('unresolvable with a null root dir also refuses rather than stamping HEAD', () => {
        const env = makeEnv();

        const sha = resolveShaOrRefuse(env, { resolvedSha: undefined, rootDir: null });

        expect(sha).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
