/**
 * @format
 * TitanEmbeddingProvider — retry-on-token-overflow tests.
 *
 * Titan Embed v2 enforces an 8,192-token input limit. The provider caps input
 * by *characters* (a ~4 chars/token heuristic), but dense content (minified
 * code, non-English, long identifiers) can exceed 8,192 tokens well under the
 * char cap. Bedrock then returns:
 *   400 ValidationException: Too many input tokens. Max input tokens: 8192,
 *   request input token count: 10937
 * which previously crashed the ingestion Job (observed on Nelson-Lamounier/
 * ai-applications). The provider must instead shrink and retry until it fits.
 */
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

import { TitanEmbeddingProvider } from './TitanEmbeddingProvider.js';

/** A successful Titan InvokeModel reply. */
function okReply(dim = 1024, tokens = 100) {
    return {
        body: Buffer.from(JSON.stringify({
            embedding:           Array.from({ length: dim }, () => 0.01),
            inputTextTokenCount: tokens,
        })),
    };
}

/** The Bedrock token-limit ValidationException, as thrown by the SDK. */
function tokenOverflowError(requestTokens: number): Error {
    const e = new Error(
        `400 Bad Request: Too many input tokens. Max input tokens: 8192, request input token count: ${requestTokens} `,
    );
    (e as { name: string }).name = 'ValidationException';
    return e;
}

/** Read the inputText sent on a given send() call index. */
function sentInputText(callIndex: number): string {
    const body = JSON.parse(
        Buffer.from(invokeModelCommand.mock.calls[callIndex]?.[0].body).toString('utf-8'),
    );
    return body.inputText as string;
}

describe('TitanEmbeddingProvider retry-on-overflow', () => {
    beforeEach(() => {
        mockSend.mockReset();
        invokeModelCommand.mockClear();
        mockRecordBedrockCost.mockClear();
    });

    it('returns the embedding directly when input is within the token limit', async () => {
        mockSend.mockResolvedValueOnce(okReply());
        const provider = new TitanEmbeddingProvider('eu-west-1', 1024);
        const out = await provider.embed('small text');
        expect(out).toHaveLength(1024);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('shrinks the input and retries when Bedrock reports too many input tokens', async () => {
        // 12000-char dense chunk; first attempt overflows at 10937 tokens.
        const dense = 'x'.repeat(12_000);
        mockSend
            .mockRejectedValueOnce(tokenOverflowError(10_937))
            .mockResolvedValueOnce(okReply());

        const provider = new TitanEmbeddingProvider('eu-west-1', 1024);
        const out = await provider.embed(dense);

        expect(out).toHaveLength(1024);
        expect(mockSend).toHaveBeenCalledTimes(2);

        // The retry must send strictly fewer characters than the first attempt,
        // sized so the projected token count is under 8192.
        const first  = sentInputText(0);
        const second = sentInputText(1);
        expect(second.length).toBeLessThan(first.length);
        // 8192 tokens * ~3 chars/token worst-case headroom => <= ~24576 chars,
        // but since the observed ratio here is 12000/10937 ≈ 1.1 chars/token,
        // the retry must shrink to roughly 8192 * (12000/10937) ≈ 8989 chars.
        expect(second.length).toBeLessThanOrEqual(9_200);
    });

    it('retries multiple times, shrinking each time, until it fits', async () => {
        const dense = 'y'.repeat(40_000);
        mockSend
            .mockRejectedValueOnce(tokenOverflowError(13_000))
            .mockRejectedValueOnce(tokenOverflowError(9_500))
            .mockResolvedValueOnce(okReply());

        const provider = new TitanEmbeddingProvider('eu-west-1', 1024);
        const out = await provider.embed(dense);

        expect(out).toHaveLength(1024);
        expect(mockSend).toHaveBeenCalledTimes(3);
        expect(sentInputText(1).length).toBeLessThan(sentInputText(0).length);
        expect(sentInputText(2).length).toBeLessThan(sentInputText(1).length);
    });

    it('gives up after a bounded number of retries and rethrows', async () => {
        const dense = 'z'.repeat(50_000);
        // Always overflow — provider must not loop forever.
        mockSend.mockRejectedValue(tokenOverflowError(12_000));

        const provider = new TitanEmbeddingProvider('eu-west-1', 1024);
        await expect(provider.embed(dense)).rejects.toThrow(/input tokens/i);
        // bounded: initial + a small fixed number of retries, not unbounded.
        expect(mockSend.mock.calls.length).toBeLessThanOrEqual(6);
        expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT retry on a non-token-limit error', async () => {
        const other = new Error('AccessDeniedException: not allowed');
        (other as { name: string }).name = 'AccessDeniedException';
        mockSend.mockRejectedValueOnce(other);

        const provider = new TitanEmbeddingProvider('eu-west-1', 1024);
        await expect(provider.embed('text')).rejects.toThrow(/not allowed/);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });
});
