/** @format */
import { describe, it, expect } from '@jest/globals';
import { joinSkillCandidates, validateSkillTransfer } from './skill-transfer.js';
import type { ProjectEvidenceInput, SkillCandidateSet, SkillTransferEntry } from './skill-transfer-types.js';

const EMPTY: ProjectEvidenceInput = { projects: [], components: [], decisions: [], stackItems: [], tags: [], highlights: [], challenges: [], repoEvidence: [] };
const input: ProjectEvidenceInput = {
  projects:   [{ id: 'p1', name: 'AI Apps' }],
  components: [{ id: 'c1', projectId: 'p1', name: 'EKS Kubernetes cluster', kind: 'infra' }],
  decisions:  [{ id: 'd1', projectId: 'p1', title: 'Chose Postgres over DynamoDB', decision: 'Relational fit' }],
  stackItems: [{ id: 's1', projectId: 'p1', name: 'Terraform', category: 'iac' }],
  tags:       [{ projectId: 'p1', tag: 'observability' }],
  highlights: [],
  challenges: [],
  repoEvidence: [{ projectId: 'p1', source: 'tech_evidence', id: 'e1', rawName: 'pgvector', fileLine: 'src/db.ts:12' }],
};

describe('joinSkillCandidates', () => {
  it('classifies component match as demonstrated', () => {
    const out = joinSkillCandidates(['Kubernetes'], input);
    const set = out.find(s => s.jdSkill === 'Kubernetes')!;
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]).toMatchObject({ source: 'component', tier: 'demonstrated', id: 'c1', projectId: 'p1', projectName: 'AI Apps' });
  });
  it('classifies stack_item match as claimed and tag match as claimed', () => {
    expect(joinSkillCandidates(['Terraform'], input)[0].candidates[0]).toMatchObject({ source: 'stack_item', tier: 'claimed', id: 's1' });
    expect(joinSkillCandidates(['observability'], input)[0].candidates[0]).toMatchObject({ source: 'tag', tier: 'claimed', id: 'p1:observability' });
  });
  it('classifies decision match as demonstrated', () => {
    expect(joinSkillCandidates(['Postgres'], input)[0].candidates[0]).toMatchObject({ source: 'decision', tier: 'demonstrated', id: 'd1' });
  });
  it('classifies repo evidence match as declared with fileLine', () => {
    expect(joinSkillCandidates(['pgvector'], input)[0].candidates[0]).toMatchObject({ source: 'tech_evidence', tier: 'declared', id: 'e1', fileLine: 'src/db.ts:12' });
  });
  it('returns an empty candidate list for an unmatched skill (gap)', () => {
    expect(joinSkillCandidates(['Kafka'], input)[0].candidates).toEqual([]);
  });
  it('does NOT spuriously match on short/stopword tokens', () => {
    expect(joinSkillCandidates(['system design'], input)[0].candidates).toEqual([]);
  });
  it('handles no projects (every skill → empty candidates)', () => {
    expect(joinSkillCandidates(['Kubernetes'], EMPTY)[0].candidates).toEqual([]);
  });
});

const sets: SkillCandidateSet[] = [
  { jdSkill: 'Kubernetes', candidates: [{ projectId: 'p1', projectName: 'AI Apps', source: 'component', tier: 'demonstrated', id: 'c1', label: 'EKS Kubernetes cluster' }] },
  { jdSkill: 'Kafka',      candidates: [] },
];

describe('validateSkillTransfer', () => {
  it('keeps a matched entry that cites a real candidate id', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [{ source: 'component', id: 'c1', label: 'EKS Kubernetes cluster' }], narrative: 'You ran EKS — maps to the JD.' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'demonstrated', projectId: 'p1' });
  });
  it('demotes to gap when the cited projectId is not a candidate (invented)', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'GHOST', projectName: 'X', evidenceRefs: [{ source: 'component', id: 'c1', label: 'x' }], narrative: 'invented' },
    ];
    const out = validateSkillTransfer(entries, sets)[0];
    expect(out).toMatchObject({ tier: 'gap', projectId: null, projectName: null, evidenceRefs: [] });
  });
  it('demotes to gap when an evidenceRef id is not a candidate', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kubernetes', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [{ source: 'component', id: 'GHOST', label: 'x' }], narrative: 'partly invented' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'gap', evidenceRefs: [] });
  });
  it('keeps a genuine gap entry as-is', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Kafka', tier: 'gap', projectId: null, projectName: null, evidenceRefs: [], narrative: 'Not shown in your projects — bridge by…' },
    ];
    expect(validateSkillTransfer(entries, sets)[0]).toMatchObject({ tier: 'gap', narrative: 'Not shown in your projects — bridge by…' });
  });
  it('drops entries for skills not in the candidate sets', () => {
    const entries: SkillTransferEntry[] = [
      { jdSkill: 'Rust', tier: 'demonstrated', projectId: 'p1', projectName: 'AI Apps', evidenceRefs: [], narrative: 'x' },
    ];
    expect(validateSkillTransfer(entries, sets)).toHaveLength(0);
  });
});
