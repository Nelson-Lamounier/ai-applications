/**
 * @format
 * Writer Agent — JSON safety-net validation tests.
 *
 * Writer keeps extended thinking (no forced tool_use), so its structured
 * metadata is guarded by a strict Zod safety-net that fails fast instead
 * of papering over malformed output with placeholder defaults.
 */

process.env['WRITER_MODEL'] = 'eu.anthropic.claude-sonnet-4-6-20260310-v1:0';

let parseWriterResponse: typeof import('./writer-agent.js')['parseWriterResponse'];

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

    it('throws fast when the model injects an unknown metadata field', () => {
        const inj = JSON.parse(VALID);
        inj.metadata.injected = 'nope';
        expect(() => parseWriterResponse(JSON.stringify(inj))).toThrow(/schema validation/i);
    });

    it('still throws on empty content (prose guard preserved)', () => {
        const noContent = JSON.parse(VALID);
        noContent.content = '';
        expect(() => parseWriterResponse(JSON.stringify(noContent))).toThrow(/content/i);
    });
});
