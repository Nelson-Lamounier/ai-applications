/** @format */
import { detectConcernEvidence } from './concern-detection.js';
import type { SystemDesignConcern, ProjectEvidenceInput } from './index.js';

const RLS: SystemDesignConcern = {
  concernId: 'data_isolation_tenant_scoping', category: 'data_isolation',
  concernQuestion: 'q', whyInterviewersAsk: 'w',
  detectionSignals: ['row level security', 'rls', 'tenant'],
  implementationPatterns: [], followUpQuestions: [], gapSignals: [],
  jdSignalKeywords: ['multi-tenant', 'isolation'], importance: 1,
};
const SCALE: SystemDesignConcern = {
  concernId: 'scaling_stateless_horizontal', category: 'scaling',
  concernQuestion: 'q', whyInterviewersAsk: 'w',
  detectionSignals: ['horizontal', 'autoscale', 'stateless'],
  implementationPatterns: [], followUpQuestions: [], gapSignals: [],
  jdSignalKeywords: ['scale'], importance: 2,
};

const evidence: ProjectEvidenceInput = {
  projects: [{ id: 'p1', name: 'Tucaken' }],
  components: [{ id: 'c1', projectId: 'p1', name: 'Tenant RLS policy layer', kind: 'backend' }],
  decisions: [], stackItems: [{ id: 's1', projectId: 'p1', name: 'tenant scoping', category: 'framework' }],
  tags: [], repoEvidence: [],
};

describe('detectConcernEvidence', () => {
  it('marks a concern strong when a component label matches a signal', () => {
    const cov = detectConcernEvidence([RLS], evidence, 'multi-tenant SaaS role');
    const d = cov.detected.find(x => x.concernId === RLS.concernId)!;
    expect(d.strength).toBe('strong');
    expect(d.evidenceRefs.map(r => r.id)).toContain('c1');
    expect(d.relevantToJd).toBe(true);
  });

  it('marks a concern none when no evidence matches', () => {
    const cov = detectConcernEvidence([SCALE], evidence, 'scale role');
    const d = cov.detected.find(x => x.concernId === SCALE.concernId)!;
    expect(d.strength).toBe('none');
    expect(d.evidenceRefs).toEqual([]);
  });

  it('counts coverage over JD-relevant concerns only', () => {
    const cov = detectConcernEvidence([RLS, SCALE], evidence, 'multi-tenant isolation role');
    // RLS relevant + strong; SCALE not JD-relevant (no "scale" token) → excluded from totals
    expect(cov.relevantTotal).toBe(1);
    expect(cov.relevantAddressed).toBe(1);
  });

  it('treats empty JD as all-relevant', () => {
    const cov = detectConcernEvidence([RLS, SCALE], evidence, '');
    expect(cov.relevantTotal).toBe(2);
  });
});
