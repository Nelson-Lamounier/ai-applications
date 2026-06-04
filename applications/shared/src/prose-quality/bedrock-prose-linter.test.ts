/** @format */
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));
const emitMock = jest.fn();
jest.mock('../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));
const recordCostMock = jest.fn(async () => {});
jest.mock('../rds/bedrock-cost.js', () => ({ recordBedrockCost: recordCostMock }));

import { BedrockProseLinter } from './bedrock-prose-linter.js';
import type { ProseQualityInput } from './prose-quality-types.js';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

function toolReply(input: unknown, usage?: { inputTokens: number; outputTokens: number }) {
    return {
        output: { message: { content: [{ toolUse: { name: 'emit_prose_quality', input } }] } },
        ...(usage ? { usage } : {}),
    } as unknown as ConverseCommandOutput;
}

const input: ProseQualityInput = {
    sections: [{ location: 'coachingNotes', register: 'advice', text: "It's worth noting you did well." }],
    stage: 'phone_screen',
};

const goodVerdict = {
    status: 'FAIL',
    score: { directness: 5, rhythm: 6, trust: 6, authenticity: 5, density: 6, total: 28 },
    belowThreshold: true,
    issues: [{ category: 'phrase', match: "It's worth noting", location: 'coachingNotes', severity: 'high', rule: 'Adverbs' }],
};

describe('BedrockProseLinter', () => {
    beforeEach(() => { sendMock.mockReset(); emitMock.mockReset(); recordCostMock.mockClear(); });

    it('parses a tool verdict into ProseQualityResult', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('FAIL');
        expect(r.belowThreshold).toBe(true);
        expect(r.score.total).toBe(28);
        expect(r.issues[0].location).toBe('coachingNotes');
    });

    it('records Bedrock cost as prose-lint when a costCtx is supplied', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict, { inputTokens: 800, outputTokens: 40 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = {} as any;
        await new BedrockProseLinter({ mode: 'flag' }).lint(input, { pool, userId: 'u-1' });
        expect(recordCostMock).toHaveBeenCalledWith(pool, expect.objectContaining({
            userId: 'u-1', pipeline: 'prose-lint', inputTokens: 800, outputTokens: 40,
        }));
    });

    it('fails OPEN on unparseable output — PASS, no issues, warns', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockResolvedValueOnce(toolReply(undefined));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('PASS');
        expect(r.belowThreshold).toBe(false);
        expect(r.issues).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('fails OPEN when the model schema is malformed (missing score)', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockResolvedValueOnce(toolReply({ status: 'FAIL', issues: [] }));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('PASS');
        warn.mockRestore();
    });

    it('returns PASS without calling Bedrock when there are no sections', async () => {
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint({ sections: [] });
        expect(r.status).toBe('PASS');
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('emits ProseChecked=1 and ProseFailed=1 on FAIL', async () => {
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict));
        await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        const metrics = emitMock.mock.calls.at(-1)?.[2];
        expect(metrics).toEqual([
            { name: 'ProseChecked', value: 1, unit: 'Count' },
            { name: 'ProseFailed', value: 1, unit: 'Count' },
        ]);
    });

    it('fails OPEN when the Bedrock call throws (transport error)', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sendMock.mockRejectedValueOnce(new Error('throttled'));
        const r = await new BedrockProseLinter({ mode: 'flag' }).lint(input);
        expect(r.status).toBe('PASS');
        expect(r.issues).toEqual([]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('does not record cost when costCtx has no userId', async () => {
        recordCostMock.mockClear();
        sendMock.mockResolvedValueOnce(toolReply(goodVerdict));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = {} as any;
        await new BedrockProseLinter({ mode: 'flag' }).lint(input, { pool, userId: '' });
        expect(recordCostMock).not.toHaveBeenCalled();
    });
});
