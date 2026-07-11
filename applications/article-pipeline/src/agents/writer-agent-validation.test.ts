/**
 * @format
 * Writer Agent — JSON safety-net validation tests.
 *
 * Writer keeps extended thinking (no forced tool_use), so its structured
 * metadata is guarded by a Zod safety-net that enforces required fields and
 * types but STRIPS unknown keys (rather than rejecting them) — a stray key
 * must not discard an already-paid-for generation.
 */

import type {
    parseWriterResponse as ParseWriterResponseFn,
    buildWriterSystemPrompt as BuildWriterSystemPromptFn,
} from './writer-agent.js';
import type { EvidenceInventory, ResearchResult } from '@bedrock/shared';

process.env['WRITER_MODEL'] = 'eu.anthropic.claude-sonnet-4-6';

let parseWriterResponse: typeof ParseWriterResponseFn;
let buildWriterSystemPrompt: typeof BuildWriterSystemPromptFn;

beforeAll(async () => {
    ({ parseWriterResponse, buildWriterSystemPrompt } = await import('./writer-agent.js'));
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

// ── Evidence-driven archetype assembly (Phase 2, flag-gated) ─────────────────

const WAR_STORY_INV: EvidenceInventory = {
    failureNarratives: 5, metrics: 3, comparisons: 0, stepSequences: 0,
    decisionRecords: 3, deepLinks: 3, diagnosticArtifacts: 4,
};

function research(inv?: EvidenceInventory): ResearchResult {
    return {
        suggestedTitle: 'EKS platform',
        evidenceInventory: inv,
        citableLinks: [{ url: 'https://docs.aws.amazon.com/x', supportsClaim: 'hop limit' }],
        publicRepos: ['cdk-monitoring'],
        publishIdentifiers: [],
        availableMetrics: [{ value: '11 minutes', measures: 'deploy time saved' }],
    } as unknown as ResearchResult;
}

function joinText(blocks: ReturnType<typeof buildWriterSystemPrompt>): string {
    return blocks.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

describe('buildWriterSystemPrompt (archetype assembly)', () => {
    afterEach(() => {
        delete process.env['ARTICLE_ARCHETYPE_ASSEMBLY'];
    });

    it('uses the static blog persona when the flag is off', () => {
        delete process.env['ARTICLE_ARCHETYPE_ASSEMBLY'];
        const blocks = buildWriterSystemPrompt(research(WAR_STORY_INV));
        expect(joinText(blocks)).not.toContain('ARCHETYPE:');
    });

    it('assembles core + selected archetype + brief when flag on and evidence eligible', () => {
        process.env['ARTICLE_ARCHETYPE_ASSEMBLY'] = '1';
        const blocks = buildWriterSystemPrompt(research(WAR_STORY_INV));
        const text = joinText(blocks);
        expect(text).toContain('ARCHETYPE: Production failure war story');
        expect(text).toContain("THIS ARTICLE'S CONSTRAINTS");
        expect(text).toContain('11 minutes — deploy time saved');
        // A cachePoint separates the cached core from the per-article suffix.
        expect(blocks.some((b) => 'cachePoint' in (b as object))).toBe(true);
    });

    it('falls back to the static persona when the inventory is absent', () => {
        process.env['ARTICLE_ARCHETYPE_ASSEMBLY'] = '1';
        const blocks = buildWriterSystemPrompt(research(undefined));
        expect(joinText(blocks)).not.toContain('ARCHETYPE:');
    });

    it('falls back to the static persona when evidence is ineligible (gate is defensive)', () => {
        process.env['ARTICLE_ARCHETYPE_ASSEMBLY'] = '1';
        const thin: EvidenceInventory = {
            failureNarratives: 1, metrics: 1, comparisons: 0, stepSequences: 0,
            decisionRecords: 0, deepLinks: 1, diagnosticArtifacts: 0,
        };
        const blocks = buildWriterSystemPrompt(research(thin));
        expect(joinText(blocks)).not.toContain('ARCHETYPE:');
    });
});
