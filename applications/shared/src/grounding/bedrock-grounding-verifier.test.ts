const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));
const recordCostMock = jest.fn(async () => {});
jest.mock('../rds/bedrock-cost.js', () => ({
    ...jest.requireActual('../rds/bedrock-cost.js'),
    recordBedrockCost: recordCostMock,
}));

import { computeCostCents } from '../rds/bedrock-cost.js';
import { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

function modelReply(text: string, usage?: { inputTokens: number; outputTokens: number }) {
    return {
        output: { message: { content: [{ text }] } },
        ...(usage ? { usage } : {}),
    } as unknown as ConverseCommandOutput;
}

describe('BedrockGroundingVerifier', () => {
    const input = { query: 'q', contextChunks: ['ctx fact A'], answer: 'A is true' };

    it('parses a GROUNDED verdict and returns the original answer (flag mode)', async () => {
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: supported by ctx'));
        const v = new BedrockGroundingVerifier({ mode: 'flag' });
        const r = await v.verify(input);
        expect(r.status).toBe('GROUNDED');
        expect(r.answer).toBe('A is true');
        expect(r.ungroundedClaims).toEqual([]);
    });

    it('records Bedrock cost as grounding-verify when a costCtx is supplied', async () => {
        recordCostMock.mockClear();
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: ok', { inputTokens: 320, outputTokens: 12 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = {} as any;
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input, { pool, userId: 'user-9' });
        expect(recordCostMock).toHaveBeenCalledTimes(1);
        expect(recordCostMock).toHaveBeenCalledWith(pool, expect.objectContaining({
            userId: 'user-9', pipeline: 'grounding-verify', agent: 'grounding-verifier', inputTokens: 320, outputTokens: 12,
        }));
    });

    it('uses the configured cost context and reports grounding usage', async () => {
        recordCostMock.mockClear();
        const onUsage = jest.fn();
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: ok', { inputTokens: 320, outputTokens: 12 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = {} as any;

        await new BedrockGroundingVerifier({
            mode: 'flag',
            costContext: {
                pool,
                userId: 'user-9',
                projectId: '00000000-0000-4000-8000-000000000001',
                traceId: '0123456789abcdef0123456789abcdef',
            },
            onUsage,
        }).verify(input);

        expect(recordCostMock).toHaveBeenCalledWith(pool, expect.objectContaining({
            pipeline: 'grounding-verify',
            agent: 'grounding-verifier',
            projectId: '00000000-0000-4000-8000-000000000001',
            traceId: '0123456789abcdef0123456789abcdef',
        }));
        expect(onUsage).toHaveBeenCalledWith({
            calls: 1,
            inputTokens: 320,
            outputTokens: 12,
            costUsd: computeCostCents('eu.anthropic.claude-haiku-4-5-20251001-v1:0', 320, 12).totalCostCents / 100,
        });
    });

    it('does not record cost when no costCtx is supplied', async () => {
        recordCostMock.mockClear();
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: ok', { inputTokens: 10, outputTokens: 1 }));
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(recordCostMock).not.toHaveBeenCalled();
    });

    it('parses NOT_GROUNDED with claims and keeps answer in flag mode', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: invented\nClaims: A is true'));
        const r = await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
        expect(r.answer).toBe('A is true');
        expect(r.ungroundedClaims).toEqual(['A is true']);
    });

    it('defaults to NOT_GROUNDED on unparseable model output (fail-safe)', async () => {
        sendMock.mockResolvedValueOnce(modelReply('no verdict here'));
        const r = await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
    });

    it('substitutes the fallback in block mode when NOT_GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: invented'));
        const r = await new BedrockGroundingVerifier({ mode: 'block', fallback: 'NOPE' }).verify(input);
        expect(r.status).toBe('NOT_GROUNDED');
        expect(r.answer).toBe('NOPE');
    });

    it('keeps the answer in block mode when GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('GROUNDED\nReason: ok'));
        const r = await new BedrockGroundingVerifier({ mode: 'block' }).verify(input);
        expect(r.answer).toBe('A is true');
    });

    it('emits GroundingChecked=1 and GroundingFailed=1 on NOT_GROUNDED', async () => {
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: x'));
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        const metrics = emitMock.mock.calls.at(-1)?.[2];
        expect(metrics).toEqual([
            { name: 'GroundingChecked', value: 1, unit: 'Count' },
            { name: 'GroundingFailed', value: 1, unit: 'Count' },
        ]);
    });

    it('warns only on unparseable output, not on legitimate NOT_GROUNDED', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockResolvedValueOnce(modelReply('NOT_GROUNDED\nReason: hallucinated'));
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(warn).not.toHaveBeenCalled();
        sendMock.mockResolvedValueOnce(modelReply('the model rambled with no verdict'));
        await new BedrockGroundingVerifier({ mode: 'flag' }).verify(input);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
