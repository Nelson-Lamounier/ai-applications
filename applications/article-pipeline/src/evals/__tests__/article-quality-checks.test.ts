/** @format */
import { describe, it, expect } from '@jest/globals';
import type { ArticleMetadata, OutlineSection, WriterResult } from '@bedrock/shared';

import {
    stripNonProse, britishEnglishViolations, outlineCoverage,
    inlineReferenceViolations, readingTimePlausible, evaluateWriterOutput,
} from '../article-quality-checks.js';

const META: ArticleMetadata = {
    title: 'T', description: 'd', tags: ['k8s'], slug: 'my-article', publishDate: '2026-06-25',
    readingTime: 3, category: 'devops', aiSummary: 's', technicalConfidence: 80,
    skillsDemonstrated: [], processingNote: '',
};

function writer(content: string, over: Partial<WriterResult> = {}): WriterResult {
    return { content, metadata: META, shotList: [], ...over };
}

describe('stripNonProse', () => {
    it('removes fenced code, inline code and JSX so code spellings do not leak', () => {
        const out = stripNonProse('Prose.\n```ts\nconst color = optimize();\n```\n`normalize()` <Foo bar="center" />');
        expect(out).toContain('Prose.');
        expect(out).not.toContain('optimize');
        expect(out).not.toContain('normalize');
        expect(out).not.toContain('center');
    });
});

describe('britishEnglishViolations', () => {
    it('flags US spellings in prose', () => {
        const v = britishEnglishViolations('We optimize the color and behavior of the center.');
        expect(v).toEqual(expect.arrayContaining(['optimize→optimise', 'color→colour', 'behavior→behaviour', 'center→centre']));
    });

    it('does NOT flag US-spelled API names inside code', () => {
        expect(britishEnglishViolations('Call `optimize()` and ```\nColor.normalize()\n```')).toEqual([]);
    });

    it('is clean for UK prose', () => {
        expect(britishEnglishViolations('We optimise the colour and behaviour of the centre.')).toEqual([]);
    });
});

describe('outlineCoverage', () => {
    const outline: OutlineSection[] = [
        { heading: 'Introduction', wordBudget: 100, keyPoints: [], needsVisual: false },
        { heading: 'Architecture', wordBudget: 200, keyPoints: [], needsVisual: false },
    ];
    it('is 1 when every heading appears in the body', () => {
        const c = outlineCoverage('# Introduction\n...\n## Architecture\n...', outline);
        expect(c.ratio).toBe(1);
        expect(c.missing).toEqual([]);
    });
    it('reports missing headings', () => {
        const c = outlineCoverage('# Introduction only', outline);
        expect(c.ratio).toBe(0.5);
        expect(c.missing).toEqual(['Architecture']);
    });
});

describe('inlineReferenceViolations', () => {
    it('flags a usedInline reference whose URL is absent from the content', () => {
        const r = writer('Body without the link.', {
            suggestedReferences: [{ label: 'AWS', url: 'https://aws.example/doc', relevance: 'x', usedInline: true }],
        });
        expect(inlineReferenceViolations(r)).toEqual(['https://aws.example/doc']);
    });
    it('passes when the inline URL is present', () => {
        const r = writer('See https://aws.example/doc for detail.', {
            suggestedReferences: [{ label: 'AWS', url: 'https://aws.example/doc', relevance: 'x', usedInline: true }],
        });
        expect(inlineReferenceViolations(r)).toEqual([]);
    });
});

describe('readingTimePlausible', () => {
    it('accepts a reading time near words/200', () => {
        const content = 'word '.repeat(600); // ~3 min
        expect(readingTimePlausible({ ...META, readingTime: 3 }, content)).toBe(true);
    });
    it('rejects a wildly wrong reading time', () => {
        const content = 'word '.repeat(600);
        expect(readingTimePlausible({ ...META, readingTime: 40 }, content)).toBe(false);
    });
    it('rejects a non-positive reading time', () => {
        expect(readingTimePlausible({ ...META, readingTime: 0 }, 'word '.repeat(600))).toBe(false);
    });
});

describe('evaluateWriterOutput', () => {
    const outline: OutlineSection[] = [{ heading: 'Setup', wordBudget: 100, keyPoints: [], needsVisual: false }];
    it('marks a clean article ok', () => {
        const content = '# Setup\n' + 'word '.repeat(600);
        const report = evaluateWriterOutput('clean', writer(content), outline);
        expect(report.ok).toBe(true);
    });
    it('fails on a US spelling + missing heading + bad slug', () => {
        const report = evaluateWriterOutput('dirty', writer('We optimize things.', { metadata: { ...META, slug: 'Bad_Slug' } }), outline);
        expect(report.ok).toBe(false);
        const failed = report.checks.filter((c) => !c.passed).map((c) => c.name);
        expect(failed).toEqual(expect.arrayContaining(['outline-coverage', 'british-english', 'metadata-slug']));
    });
});
