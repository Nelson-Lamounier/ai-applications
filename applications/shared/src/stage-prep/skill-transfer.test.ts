/** @format */
import { describe, it, expect } from '@jest/globals';
import { joinSkillCandidates } from './skill-transfer.js';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

const EMPTY: ProjectEvidenceInput = { projects: [], components: [], decisions: [], stackItems: [], tags: [], repoEvidence: [] };
const input: ProjectEvidenceInput = {
  projects:   [{ id: 'p1', name: 'AI Apps' }],
  components: [{ id: 'c1', projectId: 'p1', name: 'EKS Kubernetes cluster', kind: 'infra' }],
  decisions:  [{ id: 'd1', projectId: 'p1', title: 'Chose Postgres over DynamoDB', decision: 'Relational fit' }],
  stackItems: [{ id: 's1', projectId: 'p1', name: 'Terraform', category: 'iac' }],
  tags:       [{ projectId: 'p1', tag: 'observability' }],
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
