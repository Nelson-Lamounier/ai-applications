import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const logMock = jest.fn();
const emitMock = jest.fn();
jest.mock('../../logger.js', () => ({ log: (...a: unknown[]) => logMock(...a) }));
jest.mock('../../emf.js', () => ({ emitEmfMetric: (...a: unknown[]) => emitMock(...a) }));

import { recordZeroResultRetrieval } from '../zero-result.js';

beforeEach(() => { logMock.mockReset(); emitMock.mockReset(); });

describe('recordZeroResultRetrieval', () => {
    it('WARN-logs the hashed prompt (never the clear prompt) and emits the metric', () => {
        recordZeroResultRetrieval({
            namespace: 'NS', appLabel: 'app-x', sessionId: 'sess-1',
            prompt: 'a secret question',
        });

        expect(logMock).toHaveBeenCalledTimes(1);
        const [level, msg, data] = logMock.mock.calls[0] as [string, string, Record<string, unknown>];
        expect(level).toBe('WARN');
        expect(msg).toBe('app-x zero-result retrieval');
        expect(data.sessionId).toBe('sess-1');
        expect(typeof data.promptHash).toBe('string');
        expect(JSON.stringify(data)).not.toContain('a secret question');

        expect(emitMock).toHaveBeenCalledTimes(1);
        const [ns, , metrics] = emitMock.mock.calls[0] as [string, unknown, Array<{ name: string }>];
        expect(ns).toBe('NS');
        expect(metrics[0]?.name).toBe('ZeroResultRetrieval');
    });
});
