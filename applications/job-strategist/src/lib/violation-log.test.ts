/**
 * @format
 * Violation log — guard-violation codes must survive the run.
 *
 * Run 77e325ea (2026-07-09) fired three resume-rewrites but WHY was
 * unrecoverable afterwards: codes were only Prometheus counter increments,
 * and short-lived Job pods die before the labelled series are reliably
 * scraped (verified live: zero increase() across 209 series for that run).
 * The collector keeps every (stage, code) pair so run-pipeline can persist
 * them on pipeline_runs.metadata.guard and emit one queryable Loki line.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createViolationLog } from './violation-log.js';

describe('createViolationLog', () => {
    it('records single codes with their stage, preserving order', () => {
        const vlog = createViolationLog();
        vlog.record('instruction_scrub', 'instruction_metric_stripped');
        vlog.record('resume_guard', 'headline_is_title');
        expect(vlog.toMetadata()).toEqual({
            total: 2,
            violations: [
                { stage: 'instruction_scrub', code: 'instruction_metric_stripped' },
                { stage: 'resume_guard', code: 'headline_is_title' },
            ],
        });
    });

    it('recordAll ingests guard-result violation arrays ({ code } objects)', () => {
        const vlog = createViolationLog();
        vlog.recordAll('resume_guard', [{ code: 'a' }, { code: 'b' }]);
        expect(vlog.toMetadata()?.total).toBe(2);
        expect(vlog.toMetadata()?.violations.map((v) => v.code)).toEqual(['a', 'b']);
    });

    it('invokes the onRecord hook per violation (metric increments stay live)', () => {
        const hook = jest.fn();
        const vlog = createViolationLog(hook);
        vlog.record('s1', 'c1');
        vlog.recordAll('s2', [{ code: 'c2' }]);
        expect(hook).toHaveBeenCalledTimes(2);
        expect(hook).toHaveBeenNthCalledWith(1, 's1', 'c1');
        expect(hook).toHaveBeenNthCalledWith(2, 's2', 'c2');
    });

    it('returns null metadata for a clean run (no empty guard key in pipeline_runs)', () => {
        expect(createViolationLog().toMetadata()).toBeNull();
    });

    it('a throwing onRecord hook never loses the violation (observability stays fail-open)', () => {
        const vlog = createViolationLog(() => { throw new Error('metric registry down'); });
        expect(() => vlog.record('s', 'c')).not.toThrow();
        expect(vlog.toMetadata()?.total).toBe(1);
    });
});
