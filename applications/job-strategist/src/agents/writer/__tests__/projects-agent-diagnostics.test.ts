/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { logProjectsAgentEvents, logProjectsThemeEvidence, projectsAgentOutcome, type ProjectsAgentLogKeys } from '../projects-agent-diagnostics.js';
import { EMPTY_OPERATIONS_THEMES_DIAG, EMPTY_PROJECTS_STYLE_DIAG, type ProjectsAgentDiagnostics } from '../projects-ats-flow.js';
import type { VerifiedMatch } from '../../evidence/project-agent-inputs.js';

const keys: ProjectsAgentLogKeys = { pipelineRunId: 'pr1', applicationId: 'app1', traceId: 'tr1' };

const rewrittenDiag: ProjectsAgentDiagnostics = {
  targets: [{ skill: 'AWS', source: 'hard', verdict: 'verified', requirement: 'AWS' }] as never,
  coverageBefore: { targets: 3, covered: 1, missing: ['AWS', 'Terraform'] },
  rewrite: { fired: true, reason: 'coverage-below-targets', coverageAfter: { targets: 3, covered: 2, missing: ['Terraform'] }, kept: 'rewrite', keptReason: 'rewrite-covers-more' },
  fallback: { fired: false, reason: null },
  provenance: { firstViolations: [], rewriteViolations: ['line-3-not-cited'], composedCount: 2 },
  unresolvedRepos: [],
  normalisedExtras: 0,
  themes: EMPTY_OPERATIONS_THEMES_DIAG,
  style: EMPTY_PROJECTS_STYLE_DIAG,
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
      themes: EMPTY_OPERATIONS_THEMES_DIAG,
      style: EMPTY_PROJECTS_STYLE_DIAG,
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

  it('emits projects_style_findings (kinds + counts only) when composedFindings is positive', () => {
    const info = jest.fn();
    const styleDiag: ProjectsAgentDiagnostics = {
      ...rewrittenDiag,
      style: { composedFindings: 2, curatedAdvisories: 0, kinds: { internal_identifier: 2 } },
    };
    logProjectsAgentEvents({ info } as never, keys, styleDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('projects_style_findings');
    const styleEvent = info.mock.calls.find((c) => (c[0] as { event: string }).event === 'projects_style_findings')?.[0] as Record<string, unknown>;
    expect(styleEvent['composed']).toBe(2);
    expect(styleEvent['curated']).toBe(0);
    expect(styleEvent['kinds']).toEqual({ internal_identifier: 2 });
  });

  it('emits projects_style_findings when ONLY curatedAdvisories is positive', () => {
    const info = jest.fn();
    const styleDiag: ProjectsAgentDiagnostics = {
      ...rewrittenDiag,
      style: { composedFindings: 0, curatedAdvisories: 1, kinds: { bare_plus_numeric: 1 } },
    };
    logProjectsAgentEvents({ info } as never, keys, styleDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('projects_style_findings');
  });

  it('does not emit projects_style_findings when both counters are zero', () => {
    const info = jest.fn();
    logProjectsAgentEvents({ info } as never, keys, rewrittenDiag);
    const events = info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).not.toContain('projects_style_findings');
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

describe('logProjectsThemeEvidence', () => {
  const matches: VerifiedMatch[] = [
    { skill: 'database operations', sourceCitation: 'pgbouncer transaction pooling', evidenceFiles: ['o/tucaken-app/docs/db.md'] },
    { skill: 'database operations', sourceCitation: 'schema migration ledger', evidenceFiles: ['o/tucaken-app/docs/migrations.md'] },
    { skill: 'cluster orchestration', sourceCitation: 'EKS node autoscaling', evidenceFiles: ['o/tucaken-infra/docs/eks.md'] },
  ];

  it('emits projects_theme_evidence nested theme key -> repo -> count when matches is non-empty', () => {
    const info = jest.fn();
    logProjectsThemeEvidence({ info } as never, keys, matches);
    expect(info).toHaveBeenCalledTimes(1);
    const [payload] = info.mock.calls[0] as [Record<string, unknown>];
    expect(payload['event']).toBe('projects_theme_evidence');
    expect(payload['pipeline_run_id']).toBe('pr1');
    expect(payload['themes']).toEqual({
      'database-operations': { 'o/tucaken-app': 2 },
      'cluster-orchestration': { 'o/tucaken-infra': 1 },
    });
  });

  it('emits nothing when matches is empty', () => {
    const info = jest.fn();
    logProjectsThemeEvidence({ info } as never, keys, []);
    expect(info).not.toHaveBeenCalled();
  });
});
