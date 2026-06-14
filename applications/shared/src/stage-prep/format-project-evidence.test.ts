/** @format */
import { formatProjectEvidence } from './format-project-evidence.js';
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

const EMPTY: ProjectEvidenceInput = {
  projects: [], components: [], decisions: [], stackItems: [], tags: [], highlights: [], challenges: [], repoEvidence: [],
};

function input(over: Partial<ProjectEvidenceInput>): ProjectEvidenceInput {
  return { ...EMPTY, ...over };
}

describe('formatProjectEvidence', () => {
  it('returns empty string when there are no projects', () => {
    expect(formatProjectEvidence(EMPTY)).toBe('');
  });

  it('emits the one-entry-per-project rule and each project\'s repo github URLs', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'AI Apps', repos: ['Nelson-Lamounier/ai-applications', 'Nelson-Lamounier/kubernetes-bootstrap'] }],
    }));
    expect(out).toMatch(/1 documented project\b/);
    expect(out).toMatch(/EXACTLY ONE résumé project entry/);
    expect(out).toMatch(/never split a multi-repo/i);
    expect(out).toContain('Repos (github): github.com/Nelson-Lamounier/ai-applications, github.com/Nelson-Lamounier/kubernetes-bootstrap');
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

  it('surfaces highlights and challenges — the rich case-study signal', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'AI Apps' }],
      highlights: [
        { projectId: 'p1', title: '5-agent pipeline in production', description: 'Runs as K8s Jobs after each ingestion.' },
      ],
      challenges: [
        { projectId: 'p1', problem: 'Tech-extraction recall too low', solution: 'Parity loop drove recall 0.25 to 0.67.' },
      ],
    }));
    expect(out).toContain('Highlights:');
    expect(out).toContain('- 5-agent pipeline in production — Runs as K8s Jobs after each ingestion.');
    expect(out).toContain('Challenges solved:');
    expect(out).toContain('Tech-extraction recall too low → Parity loop drove recall 0.25 to 0.67.');
  });

  it('dedupes near-identical highlights (regeneration accumulates rows)', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'AI Apps' }],
      highlights: [
        { projectId: 'p1', title: 'Recall improved', description: 'first' },
        { projectId: 'p1', title: 'Recall Improved', description: 'second (dup title)' },
      ],
    }));
    expect(out).toContain('first');
    expect(out).not.toContain('second (dup title)');
  });

  it('includes decision context/consequences-backed decisions and richer caps', () => {
    const out = formatProjectEvidence(input({
      projects: [{ id: 'p1', name: 'AI Apps' }],
      decisions: Array.from({ length: 5 }, (_, i) => ({
        id: `d${String(i)}`, projectId: 'p1', title: `Decision ${String(i)}`, decision: 'rationale',
      })),
    }));
    // Default cap is now 5 decisions (was 3).
    expect(out).toContain('Decision 4: rationale');
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
