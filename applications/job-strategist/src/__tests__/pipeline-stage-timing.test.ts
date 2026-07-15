/**
 * @format
 * stageSeconds -- pure per-stage timing helper (job_strategist_pipeline_
 * stage_seconds{stage}). Injected clock; no real timers.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { stageSeconds, type Clock, type StageHistogram } from '../lib/stage-timing.js';

/** A clock that returns each value in `sequence` in order, then repeats the last. */
function fakeClock(sequence: number[]): Clock {
    let i = 0;
    return { now: () => sequence[Math.min(i++, sequence.length - 1)] };
}

describe('stageSeconds', () => {
    it('records elapsed seconds under the stage label on success', async () => {
        const observe = jest.fn();
        const histogram: StageHistogram = { observe };
        const clock = fakeClock([1000, 4500]); // 3.5s elapsed

        const result = await stageSeconds(histogram, 'research', async () => 'ok', clock);

        expect(result).toBe('ok');
        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith({ stage: 'research' }, 3.5);
    });

    it('records elapsed seconds even when the stage throws, and re-throws unchanged', async () => {
        const observe = jest.fn();
        const histogram: StageHistogram = { observe };
        const clock = fakeClock([2000, 6000]); // 4s elapsed
        const boom = new Error('boom');

        await expect(
            stageSeconds(histogram, 'batch1', async () => { throw boom; }, clock),
        ).rejects.toBe(boom);

        expect(observe).toHaveBeenCalledWith({ stage: 'batch1' }, 4);
    });

    it('labels distinct stages independently', async () => {
        const observe = jest.fn();
        const histogram: StageHistogram = { observe };
        const clock = fakeClock([0, 1000, 1000, 3000]); // stage A: 1s, stage B: 2s

        await stageSeconds(histogram, 'reconcile', async () => undefined, clock);
        await stageSeconds(histogram, 'batch2', async () => undefined, clock);

        expect(observe).toHaveBeenNthCalledWith(1, { stage: 'reconcile' }, 1);
        expect(observe).toHaveBeenNthCalledWith(2, { stage: 'batch2' }, 2);
    });

    it('defaults to the system clock when none is injected', async () => {
        const observe = jest.fn();
        const histogram: StageHistogram = { observe };

        await stageSeconds(histogram, 'persist', async () => undefined);

        expect(observe).toHaveBeenCalledWith({ stage: 'persist' }, expect.any(Number));
        const [, seconds] = observe.mock.calls[0] as [{ stage: string }, number];
        expect(seconds).toBeGreaterThanOrEqual(0);
    });
});
