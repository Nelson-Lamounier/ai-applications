import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jest.fn<> generic requires any to match the Bedrock SDK response union
const mockSend = jest.fn<() => Promise<any>>();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand:   jest.fn(),
}));

const mockRecordBedrockCost = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.mock('@bedrock/shared', () => ({
    recordBedrockCost: mockRecordBedrockCost,
}));

import { ProfileExtractor } from '../ProfileExtractor.js';
import type { ProfileInputBundle } from '../ProfileInputCollector.js';
import type { Pool } from 'pg';

const VALID_TOOL_INPUT = {
    project_name:  'My Project',
    one_liner:     'A platform for doing useful things for users online.',
    description:   'This is a useful platform that helps users accomplish tasks efficiently and reliably.',
    domain:        'web',
    tech_stack:    ['TypeScript', 'React'],
    role_inferred: 'creator',
    complexity:    'moderate',
    highlights:    ['Built Y achieving Z with measurable outcome across the system.'],
    signals: {
        has_readme:       true,
        has_tests:        false,
        has_ci:           false,
        has_changelog:    false,
        has_manifest:     false,
        commit_count:     10,
        primary_language: 'TypeScript',
        last_active_at:   '2025-01-01T00:00:00Z',
    },
    confidence: 0.85,
    missing:    [],
};

function makeBundle(overrides: Partial<ProfileInputBundle> = {}): ProfileInputBundle {
    return {
        repo_full_name:         'owner/my-project',
        primary_language:       'TypeScript',
        description:            'A useful platform',
        topics:                 [],
        stars:                  10,
        forks:                  1,
        is_fork:                false,
        created_at:             '2023-01-01T00:00:00Z',
        pushed_at:              new Date().toISOString(),
        commit_count:           10,
        readme:                 '# README',
        manifests:              { 'package.json': '{"scripts":{"test":"jest"}}' },
        changelog:              null,
        workflows:              { '.github/workflows/ci.yml': 'on: push' },
        recent_commit_messages: ['feat: initial commit'],
        ...overrides,
    };
}

function mockBedrockResponse(toolInput: object): void {
    mockSend.mockResolvedValueOnce({
        body: Buffer.from(JSON.stringify({
            usage: { input_tokens: 500, output_tokens: 200 },
            content: [{ type: 'tool_use', name: 'extract_repo_profile', input: toolInput }],
        })),
    });
}

describe('ProfileExtractor', () => {
    const pool = {} as Pool;
    let extractor: ProfileExtractor;

    beforeEach(() => {
        mockSend.mockReset();
        mockRecordBedrockCost.mockClear();
        extractor = new ProfileExtractor(
            'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
            pool,
        );
    });

    it('returns valid ExtractedRepoData for well-formed tool_use response', async () => {
        mockBedrockResponse(VALID_TOOL_INPUT);
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.project_name).toBe('My Project');
        expect(result.domain).toBe('web');
        expect(result.confidence).toBe(0.85);
    });

    it('overwrites signals with ground-truth from bundle', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, signals: { ...VALID_TOOL_INPUT.signals, has_tests: false } });
        const bundle = makeBundle({ manifests: { 'package.json': '{"scripts":{"test":"jest"}}' } });
        const result = await extractor.extract('user-123', bundle);
        expect(result.signals.has_tests).toBe(true);
    });

    it('overwrites has_readme = false when bundle.readme is null', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, signals: { ...VALID_TOOL_INPUT.signals, has_readme: true } });
        const bundle = makeBundle({ readme: null });
        const result = await extractor.extract('user-123', bundle);
        expect(result.signals.has_readme).toBe(false);
    });

    it('throws ProfileExtractionError(no_tool_use_block) when response has no tool block', async () => {
        mockSend.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
                usage:   { input_tokens: 100, output_tokens: 50 },
                content: [{ type: 'text', text: 'I cannot do that.' }],
            })),
        });
        await expect(extractor.extract('user-123', makeBundle()))
            .rejects.toMatchObject({ code: 'no_tool_use_block' });
    });

    it('throws ProfileExtractionError(schema_validation_failed) when tool input violates schema', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, one_liner: 'too short' });
        await expect(extractor.extract('user-123', makeBundle()))
            .rejects.toMatchObject({ code: 'schema_validation_failed' });
    });

    it('throws schema_validation_failed when the model injects an unknown field', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, injected_field: 'unexpected' });
        await expect(extractor.extract('user-123', makeBundle()))
            .rejects.toMatchObject({ code: 'schema_validation_failed' });
    });

    it('clamps an over-long one_liner to 140 chars instead of failing (regression: a long LLM tagline must not kill the whole repo ingestion)', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, one_liner: 'A'.repeat(200) });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.one_liner).toHaveLength(140);
    });

    it('clamps an over-long description to 800 chars instead of failing', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, description: 'B'.repeat(1000) });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.description).toHaveLength(800);
    });

    it('still rejects a too-short one_liner (min quality floor preserved)', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, one_liner: 'short' });
        await expect(extractor.extract('user-123', makeBundle()))
            .rejects.toMatchObject({ code: 'schema_validation_failed' });
    });

    it('calls recordBedrockCost once with pipeline profile-extraction', async () => {
        mockBedrockResponse(VALID_TOOL_INPUT);
        await extractor.extract('user-123', makeBundle());
        expect(mockRecordBedrockCost).toHaveBeenCalledTimes(1);
        expect(mockRecordBedrockCost).toHaveBeenCalledWith(
            pool,
            expect.objectContaining({ pipeline: 'profile-extraction' }),
        );
    });
});
