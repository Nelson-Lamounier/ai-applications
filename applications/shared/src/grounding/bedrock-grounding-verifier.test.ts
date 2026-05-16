const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));

import { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';

function modelReply(text: string) {
    return { output: { message: { content: [{ text }] } } } as unknown as import('@aws-sdk/client-bedrock-runtime').ConverseCommandOutput;
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
