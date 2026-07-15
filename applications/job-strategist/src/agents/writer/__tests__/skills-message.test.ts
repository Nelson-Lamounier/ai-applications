/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSkillsMessage } from '../skills-message.js';

const jd = {
  targetRole: 'Technical Services Engineer',
  requiredSkills: ['Kubernetes', 'DNS'],
  preferredSkills: ['Terraform'],
  technologyInventory: {
    languages: ['Python'], frameworks: [], infrastructure: ['Kubernetes'], tools: [], methodologies: [],
  },
} as never;

const base = {
  jd,
  verifiedMatches: [{ skill: 'Kubernetes', sourceCitation: 'infra/k8s.ts', depth: 'expert', recency: 'current', evidenceFiles: ['infra/k8s.ts'] }],
  partialMatches: [{ skill: 'Terraform', gapDescription: 'no direct evidence', transferableFoundation: 'CloudFormation experience', framingSuggestion: '', evidenceFiles: [] }],
} as never as Parameters<typeof buildSkillsMessage>[0];

describe('buildSkillsMessage', () => {
  it('emits the JD requirements section with required then preferred skills', () => {
    const msg = buildSkillsMessage(base);
    expect(msg).toContain('## JD Skill Requirements');
    expect(msg).toContain('Required:');
    expect(msg).toContain('- Kubernetes');
    expect(msg).toContain('- DNS');
    expect(msg).toContain('Preferred:');
    expect(msg).toContain('- Terraform');
  });

  it('emits verified matches with depth/recency and partial matches with the transferable foundation', () => {
    const msg = buildSkillsMessage(base);
    expect(msg).toContain('## Verified Matches');
    expect(msg).toContain('- Kubernetes (expert, current)');
    expect(msg).toContain('## Partial Matches');
    expect(msg).toContain('- Terraform -- CloudFormation experience');
  });

  it('emits the technology inventory, only for non-empty buckets', () => {
    const msg = buildSkillsMessage(base);
    expect(msg).toContain('## Technology Inventory');
    expect(msg).toContain('Languages: Python');
    expect(msg).toContain('Infrastructure: Kubernetes');
    expect(msg).not.toContain('Frameworks:');
  });

  it('never mentions education -- the reconciler owns it', () => {
    const msg = buildSkillsMessage(base);
    expect(msg.toLowerCase()).not.toContain('education');
    expect(msg.toLowerCase()).not.toContain('degree');
  });

  it('omits empty sections entirely', () => {
    const empty = {
      jd: { targetRole: 'X', requiredSkills: [], preferredSkills: [], technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] } },
      verifiedMatches: [], partialMatches: [],
    } as never as Parameters<typeof buildSkillsMessage>[0];
    const msg = buildSkillsMessage(empty);
    expect(msg).not.toContain('## Verified Matches');
    expect(msg).not.toContain('## Partial Matches');
    expect(msg).not.toContain('## Technology Inventory');
  });
});
