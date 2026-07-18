/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { parseGithubSpdx, GithubSbomExtractor } from '../GithubSbomExtractor.js';

const doc = JSON.stringify({
    sbom: {
        spdxVersion: 'SPDX-2.3',
        packages: [
            // The root document package describes the repo itself — no purl → skipped.
            { name: 'com.github.owner/repo', SPDXID: 'SPDXRef-DOCUMENT' },
            {
                name: 'cors', versionInfo: '2.8.5',
                externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/cors@2.8.5' }],
            },
            {
                name: '@aws-sdk/client-s3', versionInfo: '3.0.0',
                externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/%40aws-sdk/client-s3@3.0.0' }],
            },
        ],
    },
});

describe('parseGithubSpdx', () => {
    it('maps SPDX packages (via their purl) to github-sbom evidence, skipping purl-less ones', () => {
        const out = parseGithubSpdx(doc);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            raw_name: 'cors', ecosystem: 'npm', version: '2.8.5',
            source_layer: 'github-sbom', file_path: '(github-dependency-graph)',
        });
        expect(out[1]).toMatchObject({ raw_name: '@aws-sdk/client-s3', ecosystem: 'npm', version: '3.0.0' });
    });

    it('percent-decodes the version range (GitHub Actions 4.%2A.%2A → 4.*.*)', () => {
        const ghaDoc = JSON.stringify({ sbom: { packages: [{
            name: 'actions/checkout',
            externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:githubactions/actions/checkout@4.%2A.%2A' }],
        }] } });
        expect(parseGithubSpdx(ghaDoc)[0]).toMatchObject({
            raw_name: 'actions/checkout', ecosystem: 'githubactions', version: '4.*.*',
        });
    });

    it('returns [] for empty or non-JSON input', () => {
        expect(parseGithubSpdx('{}')).toEqual([]);
        expect(parseGithubSpdx('not json')).toEqual([]);
    });
});

function mockResponse(body: string, opts: { ok?: boolean; status?: number; contentLength?: number } = {}) {
    return {
        ok:      opts.ok ?? true,
        status:  opts.status ?? 200,
        headers: { get: (h: string) => (h === 'content-length' ? String(opts.contentLength ?? body.length) : null) },
        text:    async () => body,
    } as unknown as Response;
}

describe('GithubSbomExtractor', () => {
    it('fetches the dependency-graph SBOM and parses it into github-sbom evidence', async () => {
        const fetchImpl = jest.fn(async () => mockResponse(doc));
        const ex = new GithubSbomExtractor('owner/repo', 'tok', { fetchImpl: fetchImpl });

        const out = await ex.extract('/ignored');

        expect(out).toHaveLength(2);
        expect(out.every(e => e.source_layer === 'github-sbom')).toBe(true);
        // correct endpoint + auth
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
        expect(url).toBe('https://api.github.com/repos/owner/repo/dependency-graph/sbom');
        expect(init.headers.Authorization).toBe('Bearer tok');
    });

    it('treats 404 as "no dependency-graph SBOM" — returns [] (not a failed lane)', async () => {
        const ex = new GithubSbomExtractor('o/r', 't', {
            fetchImpl: (async () => mockResponse('', { ok: false, status: 404 })),
        });
        await expect(ex.extract('/x')).resolves.toEqual([]);
    });

    it('throws on a real error response (e.g. 403 permission) so it surfaces', async () => {
        const ex = new GithubSbomExtractor('o/r', 't', {
            fetchImpl: (async () => mockResponse('', { ok: false, status: 403 })),
        });
        await expect(ex.extract('/x')).rejects.toThrow(/403/);
    });

    it('rejects an over-cap response via content-length', async () => {
        const ex = new GithubSbomExtractor('o/r', 't', {
            maxBytes: 1000,
            fetchImpl: (async () => mockResponse('{}', { contentLength: 99_000_000 })),
        });
        await expect(ex.extract('/x')).rejects.toThrow(/too_large/);
    });
});
