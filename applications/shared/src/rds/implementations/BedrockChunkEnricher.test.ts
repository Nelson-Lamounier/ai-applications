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

    it('canonicalises skills against the alias map and dedups collapsed variants', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({
            skills: ['K8s Networking', 'kubernetes networking', 'rest api'],
        }));

        const result = await new BedrockChunkEnricher({
            aliasToCanonical: new Map([
                ['k8s networking',       'kubernetes networking'],
                ['kubernetes networking','kubernetes networking'],
                ['rest api',             'rest api design'],
            ]),
        }).enrich(chunk());

        // Two variants collapse to one canonical; the unknown-to-alias raw stays normalised.
        expect(result.skills).toEqual(['kubernetes networking', 'rest api design']);
    });

    it('keeps an unknown skill as its normalised raw when no alias matches', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: ['Some Novel Skill'] }));

        const result = await new BedrockChunkEnricher({ aliasToCanonical: new Map() })
            .enrich(chunk());

        expect(result.skills).toEqual(['some novel skill']);
    });

    it('cascade: alias wins; alias-miss falls to the fuzzy resolver; resolver-null keeps raw', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({
            skills: ['K8s Networking', 'auto scaling group config', 'totally novel thing'],
        }));
        // resolveSkill is the embedding fallback. It must be consulted ONLY for
        // skills the alias map missed.
        const resolveSkill = jest.fn(async (phrase: string) =>
            phrase === 'auto scaling group config' ? 'aws auto scaling' : null,
        );

        const result = await new BedrockChunkEnricher({
            aliasToCanonical: new Map([['k8s networking', 'kubernetes networking']]),
            resolveSkill,
        }).enrich(chunk());

        expect(result.skills).toEqual(['kubernetes networking', 'aws auto scaling', 'totally novel thing']);
        // alias hit ('k8s networking') never reaches the resolver — only the two misses do.
        expect(resolveSkill.mock.calls.map((c) => c[0])).toEqual(['auto scaling group config', 'totally novel thing']);
    });

    it('fuzzy resolver errors are non-fatal — the raw phrase is kept', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: ['weird phrase'] }));
        const resolveSkill = jest.fn(async () => { throw new Error('pgvector down'); });

        const result = await new BedrockChunkEnricher({ resolveSkill }).enrich(chunk());

        expect(result.skills).toEqual(['weird phrase']);
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

    it('enrichPack: one call returns skills keyed per chunk + one cost record (#004)', async () => {
        mockSend.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
                usage:   { input_tokens: 50, output_tokens: 20 },
                content: [{ type: 'tool_use', name: 'record_extractions', input: { extractions: [
                    { key: 'a', skills: ['kubernetes networking'] },
                    { key: 'b', skills: ['react'] },
                ] } }],
            })),
        });

        const result = await new BedrockChunkEnricher({}, { pool: {} as Pool, userId: 'u', repoName: 'r' })
            .enrichPack([{ key: 'a', filePath: 'a.ts', content: 'x' }, { key: 'b', filePath: 'b.ts', content: 'y' }]);

        expect(result.get('a')?.skills).toEqual(['kubernetes networking']);
        expect(result.get('b')?.skills).toEqual(['react']);
        expect(mockSend).toHaveBeenCalledTimes(1);            // ONE model call for the whole pack
        expect(mockRecordBedrockCost).toHaveBeenCalledTimes(1); // ONE cost record (FR-009)
    });

    it('enrichTextCanonical: in-vocab terms -> canonical, others -> NEW growth queue', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: ['kubernetes', 'NEW: webassembly', 'iac with cdk'] }));

        const result = await new BedrockChunkEnricher({}, { pool: {} as Pool, userId: 'u', repoName: 'r' })
            .enrichTextCanonical(['kubernetes', 'terraform'], 'a.ts', 'k8s manifest');

        expect(result.canonical).toEqual(['kubernetes']);               // only in-vocab kept
        expect([...result.newSkills].sort((a, b) => a.localeCompare(b))).toEqual(['iac with cdk', 'webassembly']); // gaps queued
        expect(mockRecordBedrockCost).toHaveBeenCalledTimes(1);
    });
});
