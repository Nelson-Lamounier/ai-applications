/** @format */
import { describe, it, expect } from '@jest/globals';
import { validateSkillsMembership, deterministicSkills } from '../skills-validate.js';
import type { SkillsAgentOutput } from '../skills-schema.js';
import type { JdSignal, SkillEvidenceEntry } from '@bedrock/shared';

function entry(tool: string, status: 'verified' | 'transferable' | 'gap'): SkillEvidenceEntry {
  return { tool, status, evidenceFiles: [], evidence: '', transferableBridge: '' };
}

function jd(overrides: Partial<JdSignal['technologyInventory']> = {}, extra: Partial<JdSignal> = {}): JdSignal {
  return {
    targetRole: 'Technical Services Engineer',
    requiredSkills: [], preferredSkills: [],
    technologyInventory: {
      languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [],
      ...overrides,
    },
    ...extra,
  } as never as JdSignal;
}

describe('validateSkillsMembership', () => {
  it('passes when every emitted skill matches a verified or transferable ledger tool', () => {
    const out: SkillsAgentOutput = { skills: [{ category: 'Infrastructure', skills: ['Kubernetes', 'Terraform'] }] };
    const ledger = [entry('Kubernetes', 'verified'), entry('Terraform', 'transferable')];
    expect(validateSkillsMembership(out, ledger)).toEqual([]);
  });

  it('bridges a differently-worded ledger tool via matchTier1 (bidirectional)', () => {
    const out: SkillsAgentOutput = { skills: [{ category: 'Infrastructure', skills: ['Kubernetes'] }] };
    const ledger = [entry('Kubernetes orchestration', 'verified')];
    expect(validateSkillsMembership(out, ledger)).toEqual([]);
  });

  it('flags unknown_skill for a name no verified/transferable ledger tool supports', () => {
    const out: SkillsAgentOutput = { skills: [{ category: 'Infrastructure', skills: ['Ansible'] }] };
    const ledger = [entry('Kubernetes', 'verified')];
    expect(validateSkillsMembership(out, ledger)).toEqual(['unknown_skill:Ansible']);
  });

  it('excludes gap tools -- a gap-status ledger entry never grounds an emitted skill', () => {
    const out: SkillsAgentOutput = { skills: [{ category: 'Infrastructure', skills: ['Ansible'] }] };
    const ledger = [entry('Ansible', 'gap')];
    expect(validateSkillsMembership(out, ledger)).toEqual(['unknown_skill:Ansible']);
  });

  it('flags category_cap when more than 5 categories are emitted', () => {
    const out: SkillsAgentOutput = {
      skills: Array.from({ length: 6 }, (_, i) => ({ category: `Cat${i}`, skills: ['Kubernetes'] })),
    };
    const ledger = [entry('Kubernetes', 'verified')];
    expect(validateSkillsMembership(out, ledger)).toContain('category_cap:6');
  });

  it('flags item_cap:<category>:<n> when a category has more than 8 items', () => {
    const items = Array.from({ length: 9 }, (_, i) => `Tool${i}`);
    const out: SkillsAgentOutput = { skills: [{ category: 'Tools', skills: items }] };
    const ledger = items.map((t) => entry(t, 'verified'));
    expect(validateSkillsMembership(out, ledger)).toContain('item_cap:Tools:9');
  });
});

describe('deterministicSkills', () => {
  it('groups by JD technologyInventory bucket membership, verified before transferable', () => {
    const ledger = [entry('Terraform', 'transferable'), entry('Kubernetes', 'verified')];
    const signal = jd({ infrastructure: ['Kubernetes', 'Terraform'] });
    const out = deterministicSkills(ledger, signal);
    expect(out).toEqual([{ category: 'Infrastructure', skills: ['Kubernetes', 'Terraform'] }]);
  });

  it('falls back to a single Core Skills category when the inventory names nothing', () => {
    const ledger = [entry('Kubernetes', 'verified'), entry('Terraform', 'transferable')];
    const out = deterministicSkills(ledger, jd());
    expect(out).toEqual([{ category: 'Core Skills', skills: ['Kubernetes', 'Terraform'] }]);
  });

  it('routes a tool the inventory does not name into the Core Skills catch-all', () => {
    const ledger = [entry('Kubernetes', 'verified'), entry('Figma', 'verified')];
    const signal = jd({ infrastructure: ['Kubernetes'] });
    const out = deterministicSkills(ledger, signal);
    expect(out).toEqual([
      { category: 'Infrastructure', skills: ['Kubernetes'] },
      { category: 'Core Skills', skills: ['Figma'] },
    ]);
  });

  it('caps a category at 8 items', () => {
    const tools = Array.from({ length: 9 }, (_, i) => `Tool${i}`);
    const ledger = tools.map((t) => entry(t, 'verified'));
    const signal = jd({ tools });
    const out = deterministicSkills(ledger, signal);
    expect(out).toHaveLength(1);
    expect(out[0]!.skills).toHaveLength(8);
  });

  it('never exceeds 5 categories even with every bucket plus the Core Skills catch-all populated', () => {
    const ledger = [
      entry('Python', 'verified'), entry('React', 'verified'), entry('Kubernetes', 'verified'),
      entry('Jira', 'verified'), entry('Figma', 'verified'),
    ];
    const signal = jd({ languages: ['Python'], frameworks: ['React'], infrastructure: ['Kubernetes'], tools: ['Jira'] });
    const out = deterministicSkills(ledger, signal);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.map((c) => c.category)).toEqual(['Languages', 'Frameworks', 'Infrastructure', 'Tools', 'Core Skills']);
  });

  it('returns an empty array when the ledger has no verified or transferable tools', () => {
    expect(deterministicSkills([entry('Ansible', 'gap')], jd())).toEqual([]);
  });
});
