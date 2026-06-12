/** @format */
import { formatProjectEvidence } from './format-project-evidence.js';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

const EMPTY: ProjectEvidenceInput = {
  projects: [], components: [], decisions: [], stackItems: [], tags: [], repoEvidence: [],
};

function input(over: Partial<ProjectEvidenceInput>): ProjectEvidenceInput {
  return { ...EMPTY, ...over };
}

describe('formatProjectEvidence', () => {
  it('returns empty string when there are no projects', () => {
    expect(formatProjectEvidence(EMPTY)).toBe('');
  });

  it('renders name, pitch, stack, decisions, and tags', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'Tucaken', tagline: 'tag', pitch: 'A multi-agent platform. More detail.' }],
      stackItems: [
        { id: 's1', projectId: 'p1', name: 'TypeScript', category: 'language' },
        { id: 's2', projectId: 'p1', name: 'Kubernetes', category: 'infrastructure' },
      ],
      decisions: [{ id: 'd1', projectId: 'p1', title: 'Chose Bedrock', decision: 'why' }],
      tags: [{ projectId: 'p1', tag: 'ai' }],
    }));
    expect(out).toContain('Tucaken — A multi-agent platform.');
    expect(out).toContain('Stack: TypeScript, Kubernetes');
    expect(out).toContain('Key design decisions:');
    expect(out).toContain('- Chose Bedrock: why');
    expect(out).toContain('Tags: ai');
  });

  it('falls back to tagline when pitch is absent', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'Proj', tagline: 'A tagline', pitch: null }],
    }));
    expect(out).toContain('Proj — A tagline');
  });

  it('orders richer (more-documented) projects first', () => {
    const out = formatProjectEvidence(input({
      projects: [
        { id: 'thin', name: 'Thin' },
        { id: 'rich', name: 'Rich' },
      ],
      stackItems: [{ id: 's1', projectId: 'rich', name: 'Go', category: 'language' }],
      decisions: [{ id: 'd1', projectId: 'rich', title: 'ADR', decision: null }],
    }));
    expect(out.indexOf('Rich')).toBeLessThan(out.indexOf('Thin'));
  });

  it('caps the number of projects', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${String(i)}`, name: `P${String(i)}` }));
    const out = formatProjectEvidence(input({ projects }), { maxProjects: 3 });
    expect(out).toContain('3. ');
    expect(out).not.toContain('4. ');
  });
});
