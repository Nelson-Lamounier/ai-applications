/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { logSummaryAtsEvents, summaryAtsOutcome, type SummaryAtsLogKeys } from '../summary-ats-diagnostics.js';
import type { SummaryAtsDiagnostics } from '../summary-ats-flow.js';

const keys: SummaryAtsLogKeys = { pipelineRunId: 'pr1', applicationId: 'app1', traceId: 'tr1' };

const rewrittenDiag: SummaryAtsDiagnostics = {
  targets: [{ skill: 'AWS', source: 'hard', verdict: 'verified' }],
  coverageBefore: { targets: 3, covered: 1, missing: ['AWS', 'Terraform'] },
  rewrite: { fired: true, reason: 'coverage-below-min', coverageAfter: { targets: 3, covered: 2, missing: ['Terraform'] }, kept: 'rewrite', keptReason: 'rewrite-covers-more' },
  fallback: { fired: false, reason: null },
  guardRejections: ['first:namesGap'],
};

describe('logSummaryAtsEvents', () => {
  it('emits targets, scored, rewrite, guard_reject with correlation keys', () => {
    const info = jest.fn();
    logSummaryAtsEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(['summary_ats_targets', 'summary_ats_scored', 'summary_ats_rewrite', 'summary_ats_guard_reject']));
    for (const c of info.mock.calls) {
      const o = c[0] as Record<string, unknown>;
      expect(o['pipeline_run_id']).toBe('pr1');
      expect(o['application_id']).toBe('app1');
      expect(o['trace_id']).toBe('tr1');
    }
  });

  it('emits a fallback event and no rewrite event when the agent fell back', () => {
    const info = jest.fn();
    const fbDiag: SummaryAtsDiagnostics = {
      targets: [], coverageBefore: { targets: 0, covered: 0, missing: [] },
      rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: true, reason: 'schema parse failed' }, guardRejections: [],
    };
    logSummaryAtsEvents({ info } as never, keys, fbDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('summary_ats_fallback');
    expect(events).not.toContain('summary_ats_rewrite');
  });
});

describe('summaryAtsOutcome', () => {
  it('maps rewritten / kept_first / aware / fallback to bounded outcome+reason', () => {
    expect(summaryAtsOutcome(rewrittenDiag)).toEqual({ outcome: 'rewritten', reason: 'rewrite-covers-more' });
    const keptFirst = { ...rewrittenDiag, rewrite: { ...rewrittenDiag.rewrite, kept: 'first' as const, keptReason: 'no-coverage-gain' } };
    expect(summaryAtsOutcome(keptFirst)).toEqual({ outcome: 'kept_first', reason: 'no-coverage-gain' });
    const aware = { ...rewrittenDiag, rewrite: { fired: false, reason: 'coverage-met', coverageAfter: null, kept: null, keptReason: null } };
    expect(summaryAtsOutcome(aware)).toEqual({ outcome: 'aware', reason: 'coverage-met' });
    const fb = { ...rewrittenDiag, fallback: { fired: true, reason: 'anything at all -- unbounded' } };
    // fallback reason MUST be the bounded token, never the raw error message
    expect(summaryAtsOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'agent-error' });
  });
});
