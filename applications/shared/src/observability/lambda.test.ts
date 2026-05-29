import * as AWSXRay from 'aws-xray-sdk-core';

import { activeTraceContext, withSpan } from './lambda';

jest.mock('aws-xray-sdk-core', () => ({
    setContextMissingStrategy: jest.fn(),
    getSegment: jest.fn(),
}));

const getSegment = AWSXRay.getSegment as jest.Mock;

describe('activeTraceContext', () => {
    const original = process.env['_X_AMZN_TRACE_ID'];
    afterEach(() => {
        if (original === undefined) delete process.env['_X_AMZN_TRACE_ID'];
        else process.env['_X_AMZN_TRACE_ID'] = original;
    });

    it('returns {} when no X-Ray trace header is present', () => {
        delete process.env['_X_AMZN_TRACE_ID'];
        expect(activeTraceContext()).toEqual({});
    });

    it('parses Root → trace_id and Parent → span_id', () => {
        process.env['_X_AMZN_TRACE_ID'] =
            'Root=1-5e1b4151-5ac6c58dc39a6f7d8b1c;Parent=53995c3f42cd8ad8;Sampled=1';
        expect(activeTraceContext()).toEqual({
            trace_id: '1-5e1b4151-5ac6c58dc39a6f7d8b1c',
            span_id: '53995c3f42cd8ad8',
        });
    });
});

describe('withSpan', () => {
    afterEach(() => jest.clearAllMocks());

    it('runs the handler unwrapped when no X-Ray segment is in scope', async () => {
        getSegment.mockReturnValue(undefined);
        const handler = jest.fn(async (x: number) => x + 1);
        const result = await withSpan('test', handler)(41);
        expect(result).toBe(42);
        expect(handler).toHaveBeenCalledWith(41);
    });

    it('opens + closes a subsegment around the handler on success', async () => {
        const sub = { close: jest.fn() };
        const segment = { addNewSubsegment: jest.fn(() => sub) };
        getSegment.mockReturnValue(segment);

        const result = await withSpan('chatbot.handler', async () => 'ok')();

        expect(segment.addNewSubsegment).toHaveBeenCalledWith('chatbot.handler');
        expect(result).toBe('ok');
        expect(sub.close).toHaveBeenCalledWith();
    });

    it('closes the subsegment with the error and rethrows on failure', async () => {
        const sub = { close: jest.fn() };
        const segment = { addNewSubsegment: jest.fn(() => sub) };
        getSegment.mockReturnValue(segment);
        const boom = new Error('boom');

        await expect(
            withSpan('h', async () => { throw boom; })(),
        ).rejects.toBe(boom);
        expect(sub.close).toHaveBeenCalledWith(boom);
    });
});
