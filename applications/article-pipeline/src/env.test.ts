/** @format */
import { describe, it, expect, afterEach } from '@jest/globals';

import { parseArticleBrief } from './env.js';

const ORIGINAL = process.env['ARTICLE_BRIEF'];

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['ARTICLE_BRIEF'];
    else process.env['ARTICLE_BRIEF'] = ORIGINAL;
});

describe('parseArticleBrief', () => {
    it('returns undefined when ARTICLE_BRIEF is unset', () => {
        delete process.env['ARTICLE_BRIEF'];
        expect(parseArticleBrief()).toBeUndefined();
    });

    it('parses a structured brief with verified metrics', () => {
        process.env['ARTICLE_BRIEF'] = JSON.stringify({
            problem: 'Per-chunk enrichment cost EUR5/repo',
            angle: 'FinOps for AI pipelines',
            verifiedMetrics: [{ label: 'cost per repo', value: '0.30', unit: 'EUR', source: 'commit abc' }],
        });
        const brief = parseArticleBrief();
        expect(brief?.problem).toContain('EUR5');
        expect(brief?.verifiedMetrics?.[0]?.value).toBe('0.30');
    });

    it('fails open to undefined on malformed JSON (never breaks the run)', () => {
        process.env['ARTICLE_BRIEF'] = '{not valid json';
        expect(parseArticleBrief()).toBeUndefined();
    });
});
