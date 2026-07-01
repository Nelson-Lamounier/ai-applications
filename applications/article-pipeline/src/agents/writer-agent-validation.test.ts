/**
 * @format
 * Writer Agent — JSON safety-net validation tests.
 *
 * Writer keeps extended thinking (no forced tool_use), so its structured
 * metadata is guarded by a Zod safety-net that enforces required fields and
 * types but STRIPS unknown keys (rather than rejecting them) — a stray key
 * must not discard an already-paid-for generation.
 */

import type { parseWriterResponse as ParseWriterResponseFn } from './writer-agent.js';

process.env['WRITER_MODEL'] = 'eu.anthropic.claude-sonnet-4-6';

let parseWriterResponse: typeof ParseWriterResponseFn;

beforeAll(async () => {
    ({ parseWriterResponse } = await import('./writer-agent.js'));
});

const VALID = JSON.stringify({
    content: '# Title\n\nBody content here.',
    metadata: {
        title: 'Scaling EKS', description: 'How to scale EKS clusters effectively.',
        tags: ['aws', 'kubernetes'], slug: 'scaling-eks', publishDate: '2026-05-17',
        readingTime: 9, category: 'DevOps', aiSummary: 'A guide to EKS scaling.',
        technicalConfidence: 88, skillsDemonstrated: ['eks'], processingNote: 'ok',
    },
    shotList: [{ id: 'arch-1', type: 'diagram', instruction: 'draw it', context: 'why' }],
    suggestedReferences: [{ label: 'AWS', url: 'https://aws.amazon.com', relevance: 'official', usedInline: true }],
});

describe('parseWriterResponse safety-net', () => {
    it('returns a validated WriterResult and clamps technicalConfidence', () => {
        const over = JSON.parse(VALID);
        over.metadata.technicalConfidence = 150;
        const r = parseWriterResponse(JSON.stringify(over));
        expect(r.metadata.technicalConfidence).toBe(100);
        expect(r.metadata.title).toBe('Scaling EKS');
        expect(r.shotList).toHaveLength(1);
    });

    it('throws fast when metadata is missing a required field', () => {
        const broken = JSON.parse(VALID);
        delete broken.metadata.title;
        expect(() => parseWriterResponse(JSON.stringify(broken))).toThrow(/schema validation/i);
    });

    it('strips an unknown metadata field instead of failing the run', () => {
        const inj = JSON.parse(VALID);
        inj.metadata.injected = 'nope';
        const r = parseWriterResponse(JSON.stringify(inj));
        expect('injected' in r.metadata).toBe(false);
        expect(r.metadata.title).toBe('Scaling EKS');
    });

    it('strips the stray `author` key the model echoes from the frontmatter (regression)', () => {
        const withAuthor = JSON.parse(VALID);
        withAuthor.metadata.author = 'Nelson Lamounier';
        const r = parseWriterResponse(JSON.stringify(withAuthor));
        expect('author' in r.metadata).toBe(false);
        expect(r.metadata.title).toBe('Scaling EKS');
        expect(r.metadata.tags).toEqual(['aws', 'kubernetes']);
    });

    it('still throws on empty content (prose guard preserved)', () => {
        const noContent = JSON.parse(VALID);
        noContent.content = '';
        expect(() => parseWriterResponse(JSON.stringify(noContent))).toThrow(/content/i);
    });
});
