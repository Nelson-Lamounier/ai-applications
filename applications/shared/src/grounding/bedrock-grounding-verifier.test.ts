const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));

import { BedrockGroundingVerifier } from './bedrock-grounding-verifier.js';

function modelReply(text: string) {
    return { output: { message: { content: [{ text }] } } };
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
});
