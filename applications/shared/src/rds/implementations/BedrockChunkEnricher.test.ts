import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jest.fn<> generic requires any to match the Bedrock SDK response union
const mockSend = jest.fn<() => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock factory must accept any to satisfy InvokeModelCommand constructor signature
const invokeModelCommand = jest.fn<(args: any) => any>((args) => ({ args }));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand:   invokeModelCommand,
}));

const mockRecordBedrockCost = jest.fn<() => Promise<void>>(async () => {});
jest.mock('../bedrock-cost.js', () => ({ recordBedrockCost: mockRecordBedrockCost }));

import { BedrockChunkEnricher } from './BedrockChunkEnricher.js';
import type { RawChunk } from '../types.js';
import type { Pool } from 'pg';

function chunk(): RawChunk {
    return {
        filePath: 'README.md',
        heading:  'Overview',
        content:  'We deploy with Kubernetes and Calico.',
    } as RawChunk;
}

function bedrockReply(toolInput: object) {
    return {
        body: Buffer.from(JSON.stringify({
            usage:   { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'tool_use', name: 'record_extraction', input: toolInput }],
        })),
    };
}

describe('BedrockChunkEnricher', () => {
    beforeEach(() => {
        mockSend.mockReset();
        invokeModelCommand.mockClear();
        mockRecordBedrockCost.mockClear();
    });

    it('sends a tool schema with additionalProperties:false (no invented fields)', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: [], technologies: [] }));
        await new BedrockChunkEnricher().enrich(chunk());

        const sentBody = JSON.parse(
            Buffer.from(invokeModelCommand.mock.calls[0]?.[0].body).toString('utf-8'),
        );
        expect(sentBody.tools[0].input_schema.additionalProperties).toBe(false);
    });

    it('normalises arrays and ignores any extra field the model emits', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({
            skills:       ['Kubernetes Networking', 'kubernetes networking'],
            technologies: ['Calico'],
            injected:     'nope',
        }));

        const result = await new BedrockChunkEnricher().enrich(chunk());

        expect(result.skills).toEqual(['kubernetes networking']);
        // technologies extraction decommissioned 2026-05-27 — field is
        // always [] regardless of what the model returns.
        expect(result.technologies).toEqual([]);
        expect(result).not.toHaveProperty('injected');
    });

    it('tool schema only requests skills (technologies decommissioned 2026-05-27)', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: [] }));
        await new BedrockChunkEnricher().enrich(chunk());

        const sentBody = JSON.parse(
            Buffer.from(invokeModelCommand.mock.calls[0]?.[0].body).toString('utf-8'),
        );
        const schema = sentBody.tools[0].input_schema;
        expect(Object.keys(schema.properties)).toEqual(['skills']);
        expect(schema.required).toEqual(['skills']);
    });

    it('records bedrock cost from response usage when costCtx is provided', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: [], technologies: [] }));
        const pool = {} as Pool;

        await new BedrockChunkEnricher(
            { modelId: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0' },
            { pool, userId: 'user-1', repoName: 'owner/repo' },
        ).enrich(chunk());

        expect(mockRecordBedrockCost).toHaveBeenCalledTimes(1);
        expect(mockRecordBedrockCost).toHaveBeenCalledWith(pool, expect.objectContaining({
            userId:       'user-1',
            pipeline:     'repo-sync',
            repoName:     'owner/repo',
            modelId:      'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
            inputTokens:  10,
            outputTokens: 5,
        }));
    });

    it('records cost even when the model returns no tool_use block', async () => {
        mockSend.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
                usage:   { input_tokens: 7, output_tokens: 0 },
                content: [{ type: 'text', text: 'sorry' }],
            })),
        });
        const pool = {} as Pool;

        const result = await new BedrockChunkEnricher(
            {},
            { pool, userId: 'user-1', repoName: 'owner/repo' },
        ).enrich(chunk());

        expect(result).toEqual({ skills: [], technologies: [] });
        expect(mockRecordBedrockCost).toHaveBeenCalledTimes(1);
        expect(mockRecordBedrockCost).toHaveBeenCalledWith(pool, expect.objectContaining({
            inputTokens: 7, outputTokens: 0,
        }));
    });

    it('does not record cost when no costCtx is provided', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: [], technologies: [] }));
        await new BedrockChunkEnricher().enrich(chunk());
        expect(mockRecordBedrockCost).not.toHaveBeenCalled();
    });
});
