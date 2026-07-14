/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { logExperienceAgentEvents, experienceAgentOutcome, type ExperienceAgentLogKeys } from '../experience-agent-diagnostics.js';
import type { ExperienceAgentDiagnostics } from '../experience-ats-flow.js';

const keys: ExperienceAgentLogKeys = { pipelineRunId: 'pr1', applicationId: 'app1', traceId: 'tr1' };

const rewrittenDiag: ExperienceAgentDiagnostics = {
  targets: [{ skill: 'AWS', source: 'hard', verdict: 'verified', requirement: 'AWS' }] as never,
  coverageBefore: { targets: 3, covered: 1, missing: ['AWS', 'Terraform'] },
  rewrite: { fired: true, reason: 'coverage-below-targets', coverageAfter: { targets: 3, covered: 2, missing: ['Terraform'] }, kept: 'rewrite', keptReason: 'rewrite-covers-more' },
  fallback: { fired: false, reason: null },
  provenance: { firstViolations: [], rewriteViolations: ['line-3-not-cited'], droppedLines: 0 },
};

describe('logExperienceAgentEvents', () => {
  it('emits targets, scored, rewrite, provenance_reject with correlation keys', () => {
    const info = jest.fn();
    logExperienceAgentEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(['experience_agent_targets', 'experience_agent_scored', 'experience_agent_rewrite', 'experience_agent_provenance_reject']));
    for (const c of info.mock.calls) {
      const o = c[0] as Record<string, unknown>;
      expect(o['pipeline_run_id']).toBe('pr1');
      expect(o['application_id']).toBe('app1');
      expect(o['trace_id']).toBe('tr1');
    }
    const rejectEvent = info.mock.calls.find((c) => (c[0] as { event: string }).event === 'experience_agent_provenance_reject')?.[0] as Record<string, unknown>;
    expect(rejectEvent['which']).toBe('rewrite');
    expect(rejectEvent['tokens']).toEqual(['line-3-not-cited']);
  });

  it('does not emit provenance_reject when both violation lists are empty', () => {
    const info = jest.fn();
    const cleanDiag: ExperienceAgentDiagnostics = { ...rewrittenDiag, provenance: { firstViolations: [], rewriteViolations: [], droppedLines: 0 } };
    logExperienceAgentEvents({ info } as never, keys, cleanDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).not.toContain('experience_agent_provenance_reject');
  });

  it('emits a fallback event and no rewrite event when the agent fell back', () => {
    const info = jest.fn();
    const fbDiag: ExperienceAgentDiagnostics = {
      targets: [], coverageBefore: { targets: 0, covered: 0, missing: [] },
      rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: true, reason: 'schema parse failed' },
      provenance: { firstViolations: [], rewriteViolations: [], droppedLines: 0 },
    };
    logExperienceAgentEvents({ info } as never, keys, fbDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('experience_agent_fallback');
    expect(events).not.toContain('experience_agent_rewrite');
  });
});

describe('experienceAgentOutcome', () => {
  it('maps rewritten / kept_first / aware to bounded outcome+reason', () => {
    expect(experienceAgentOutcome(rewrittenDiag)).toEqual({ outcome: 'rewritten', reason: 'rewrite-covers-more' });
    const keptFirst = { ...rewrittenDiag, rewrite: { ...rewrittenDiag.rewrite, kept: 'first' as const, keptReason: 'no-coverage-gain' } };
    expect(experienceAgentOutcome(keptFirst)).toEqual({ outcome: 'kept_first', reason: 'no-coverage-gain' });
    const aware = { ...rewrittenDiag, rewrite: { fired: false, reason: 'coverage-met', coverageAfter: null, kept: null, keptReason: null } };
    expect(experienceAgentOutcome(aware)).toEqual({ outcome: 'aware', reason: 'coverage-met' });
  });

  it('maps fallback to the bounded agent-error token, never the raw error message', () => {
    const fb = { ...rewrittenDiag, fallback: { fired: true, reason: 'anything at all -- unbounded' }, provenance: { firstViolations: [], rewriteViolations: [], droppedLines: 0 } };
    expect(experienceAgentOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'agent-error' });
  });

  it('maps fallback with non-empty firstViolations to the bounded provenance-invalid token', () => {
    const fb = {
      ...rewrittenDiag,
      fallback: { fired: true, reason: 'ExperienceProvenanceError: line-1-not-cited' },
      provenance: { firstViolations: ['line-1-not-cited'], rewriteViolations: [], droppedLines: 0 },
    };
    expect(experienceAgentOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'provenance-invalid' });
  });
});
