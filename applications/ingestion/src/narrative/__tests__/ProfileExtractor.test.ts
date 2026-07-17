import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ProfileExtractor now goes through the shared runAgent() wrapper. The mock
// emulates it: run the agent's parseResponse over the configured tool input
// (so schema validation/clamping is still exercised) and fire the cost sink.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentToolInput: any = {};
let runAgentThrows: Error | null = null;
const mockRecordBedrockCost = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunAgent = jest.fn(async (opts: any) => {
    if (runAgentThrows) throw runAgentThrows;
    const data = await opts.parseResponse(JSON.stringify(currentToolInput));
    if (opts.pipelineContext.onInvocationComplete) {
        await opts.pipelineContext.onInvocationComplete({
            userId:             opts.pipelineContext.userId,
            modelId:            opts.config.modelId,
            systemPromptTokens: 500,
            userMessageTokens:  0,
            outputTokens:       200,
        });
    }
    return { data, tokenUsage: { inputTokens: 500, outputTokens: 200, thinkingTokens: 0 }, durationMs: 1, agentName: opts.config.agentName, modelId: opts.config.modelId, costUsd: 0 };
});

jest.mock('@bedrock/shared', () => ({
    recordBedrockCost: mockRecordBedrockCost,
    runAgent: (opts: unknown) => mockRunAgent(opts),
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
    currentToolInput = toolInput;
    runAgentThrows = null;
}

describe('ProfileExtractor', () => {
    const pool = {} as Pool;
    let extractor: ProfileExtractor;

    beforeEach(() => {
        mockRunAgent.mockClear();
        mockRecordBedrockCost.mockClear();
        currentToolInput = {};
        runAgentThrows = null;
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

    it('maps a runAgent failure (no tool_use / refusal / Bedrock error) to ProfileExtractionError(bedrock_error)', async () => {
        runAgentThrows = new Error('forced tool produced no tool_use block');
        await expect(extractor.extract('user-123', makeBundle()))
            .rejects.toMatchObject({ code: 'bedrock_error' });
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

    it('truncates a 7-element highlights array to 5 instead of failing (regression: a few extra bullets must not kill the whole repo ingestion)', async () => {
        const seven = Array.from({ length: 7 }, (_, i) => `Built feature ${i} achieving a measurable outcome across the system.`);
        mockBedrockResponse({ ...VALID_TOOL_INPUT, highlights: seven });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.highlights).toHaveLength(5);
    });

    it('coerces a stringified-JSON-array highlights into a string[] instead of failing (regression: Haiku sometimes returns highlights as a JSON string)', async () => {
        mockBedrockResponse({
            ...VALID_TOOL_INPUT,
            highlights: '["Shipped feature A end to end.", "Cut latency by half."]',
        });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.highlights).toEqual([
            'Shipped feature A end to end.',
            'Cut latency by half.',
        ]);
    });

    it('coerces a newline/bullet-delimited highlights string into a string[] instead of failing', async () => {
        mockBedrockResponse({
            ...VALID_TOOL_INPUT,
            highlights: '- Built the ingestion pipeline\n- Added retrieval probe\n* Wired cost tracking',
        });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.highlights).toEqual([
            'Built the ingestion pipeline',
            'Added retrieval probe',
            'Wired cost tracking',
        ]);
    });

    it('wraps a single plain-string highlights value into a one-element array', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, highlights: 'A single ungrounded highlight sentence.' });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.highlights).toEqual(['A single ungrounded highlight sentence.']);
    });

    it('coerces an empty highlights string to an empty array', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, highlights: '' });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.highlights).toEqual([]);
    });

    it('coerces a stringified tech_stack into a string[] instead of failing', async () => {
        mockBedrockResponse({ ...VALID_TOOL_INPUT, tech_stack: '["TypeScript", "React"]' });
        const result = await extractor.extract('user-123', makeBundle());
        expect(result.tech_stack).toEqual(['TypeScript', 'React']);
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
