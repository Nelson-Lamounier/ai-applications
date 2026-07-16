/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { logProjectsAgentEvents, projectsAgentOutcome, type ProjectsAgentLogKeys } from '../projects-agent-diagnostics.js';
import type { ProjectsAgentDiagnostics } from '../projects-ats-flow.js';

const keys: ProjectsAgentLogKeys = { pipelineRunId: 'pr1', applicationId: 'app1', traceId: 'tr1' };

const rewrittenDiag: ProjectsAgentDiagnostics = {
  targets: [{ skill: 'AWS', source: 'hard', verdict: 'verified', requirement: 'AWS' }] as never,
  coverageBefore: { targets: 3, covered: 1, missing: ['AWS', 'Terraform'] },
  rewrite: { fired: true, reason: 'coverage-below-targets', coverageAfter: { targets: 3, covered: 2, missing: ['Terraform'] }, kept: 'rewrite', keptReason: 'rewrite-covers-more' },
  fallback: { fired: false, reason: null },
  provenance: { firstViolations: [], rewriteViolations: ['line-3-not-cited'], composedCount: 2 },
  unresolvedRepos: [],
  normalisedExtras: 0,
};

describe('logProjectsAgentEvents', () => {
  it('emits targets, scored, rewrite, provenance_reject with correlation keys', () => {
    const info = jest.fn();
    logProjectsAgentEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(['projects_agent_targets', 'projects_agent_scored', 'projects_agent_rewrite', 'projects_agent_provenance_reject']));
    for (const c of info.mock.calls) {
      const o = c[0] as Record<string, unknown>;
      expect(o['pipeline_run_id']).toBe('pr1');
      expect(o['application_id']).toBe('app1');
      expect(o['trace_id']).toBe('tr1');
    }
    const rejectEvent = info.mock.calls.find((c) => (c[0] as { event: string }).event === 'projects_agent_provenance_reject')?.[0] as Record<string, unknown>;
    expect(rejectEvent['which']).toBe('rewrite');
    expect(rejectEvent['tokens']).toEqual(['line-3-not-cited']);
  });

  it('emits projects_agent_normalised with the count only when normalisedExtras is positive', () => {
    const info = jest.fn();
    const normalisedDiag: ProjectsAgentDiagnostics = { ...rewrittenDiag, normalisedExtras: 12 };
    logProjectsAgentEvents({ info } as never, keys, normalisedDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('projects_agent_normalised');
    const normalisedEvent = info.mock.calls.find((c) => (c[0] as { event: string }).event === 'projects_agent_normalised')?.[0] as Record<string, unknown>;
    expect(normalisedEvent['extras']).toBe(12);
  });

  it('does not emit projects_agent_normalised when normalisedExtras is 0', () => {
    const info = jest.fn();
    logProjectsAgentEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).not.toContain('projects_agent_normalised');
  });

  it('does not emit provenance_reject when both violation lists are empty', () => {
    const info = jest.fn();
    const cleanDiag: ProjectsAgentDiagnostics = { ...rewrittenDiag, provenance: { firstViolations: [], rewriteViolations: [], composedCount: 2 } };
    logProjectsAgentEvents({ info } as never, keys, cleanDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).not.toContain('projects_agent_provenance_reject');
  });

  it('emits a fallback event and no rewrite event when the agent fell back', () => {
    const info = jest.fn();
    const fbDiag: ProjectsAgentDiagnostics = {
      targets: [], coverageBefore: { targets: 0, covered: 0, missing: [] },
      rewrite: { fired: false, reason: null, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: true, reason: 'schema parse failed' },
      provenance: { firstViolations: [], rewriteViolations: [], composedCount: 0 },
      unresolvedRepos: [],
      normalisedExtras: 0,
    };
    logProjectsAgentEvents({ info } as never, keys, fbDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('projects_agent_fallback');
    expect(events).not.toContain('projects_agent_rewrite');
  });

  it('emits projects_repo_unresolved with the name list only when unresolvedRepos is non-empty', () => {
    const info = jest.fn();
    const unresolvedDiag: ProjectsAgentDiagnostics = { ...rewrittenDiag, unresolvedRepos: ['org/repo-a', 'org/repo-b'] };
    logProjectsAgentEvents({ info } as never, keys, unresolvedDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('projects_repo_unresolved');
    const unresolvedEvent = info.mock.calls.find((c) => (c[0] as { event: string }).event === 'projects_repo_unresolved')?.[0] as Record<string, unknown>;
    expect(unresolvedEvent['repos']).toEqual(['org/repo-a', 'org/repo-b']);
  });

  it('does not emit projects_repo_unresolved when unresolvedRepos is empty', () => {
    const info = jest.fn();
    logProjectsAgentEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).not.toContain('projects_repo_unresolved');
  });
});

describe('projectsAgentOutcome', () => {
  it('maps rewritten / kept_first / aware to bounded outcome+reason', () => {
    expect(projectsAgentOutcome(rewrittenDiag)).toEqual({ outcome: 'rewritten', reason: 'rewrite-covers-more' });
    const keptFirst = { ...rewrittenDiag, rewrite: { ...rewrittenDiag.rewrite, kept: 'first' as const, keptReason: 'no-coverage-gain' } };
    expect(projectsAgentOutcome(keptFirst)).toEqual({ outcome: 'kept_first', reason: 'no-coverage-gain' });
    const aware = { ...rewrittenDiag, rewrite: { fired: false, reason: 'coverage-met', coverageAfter: null, kept: null, keptReason: null } };
    expect(projectsAgentOutcome(aware)).toEqual({ outcome: 'aware', reason: 'coverage-met' });
  });

  it('maps fallback to the bounded agent-error token, never the raw error message', () => {
    const fb = { ...rewrittenDiag, fallback: { fired: true, reason: 'anything at all -- unbounded' }, provenance: { firstViolations: [], rewriteViolations: [], composedCount: 0 } };
    expect(projectsAgentOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'agent-error' });
  });

  it('maps fallback with non-empty firstViolations to the bounded provenance-invalid token', () => {
    const fb = {
      ...rewrittenDiag,
      fallback: { fired: true, reason: 'ProjectsProvenanceError: line-1-not-cited' },
      provenance: { firstViolations: ['line-1-not-cited'], rewriteViolations: [], composedCount: 0 },
    };
    expect(projectsAgentOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'provenance-invalid' });
  });

  it('maps an unbounded fallback.reason to the fixed agent-error token regardless of content', () => {
    const fb = {
      ...rewrittenDiag,
      fallback: { fired: true, reason: 'TypeError: Cannot read properties of undefined (reading foo) at some/internal/path.ts:123' },
      provenance: { firstViolations: [], rewriteViolations: [], composedCount: 0 },
    };
    expect(projectsAgentOutcome(fb)).toEqual({ outcome: 'fallback', reason: 'agent-error' });
  });
});
