/** @format */
import { describe, it, expect } from '@jest/globals';
import { ProjectsAgentOutputSchema, isCurated, normaliseProjectsAgentOutput } from '../projects-schema.js';

describe('ProjectsAgentOutputSchema', () => {
  it('accepts curated-id and composed-cited highlight variants', () => {
    const out = ProjectsAgentOutputSchema.parse({
      entries: [{
        name: 'Tucaken', github: 'github.com/o/tucaken-app', description: 'A platform.',
        highlights: [{ bulletId: 'p0.b1' }, { text: 'Applied DNS hardening across the API', sources: ['p0.r1'] }],
      }],
    });
    expect(isCurated(out.entries[0]!.highlights[0]!)).toBe(true);
    expect(isCurated(out.entries[0]!.highlights[1]!)).toBe(false);
  });
  it('rejects a highlight that is neither variant, and a composed bullet without sources', () => {
    expect(() => ProjectsAgentOutputSchema.parse({
      entries: [{ name: 'X', github: '', description: '', highlights: [{ nonsense: true }] }],
    })).toThrow();
    expect(() => ProjectsAgentOutputSchema.parse({
      entries: [{ name: 'X', github: '', description: '', highlights: [{ text: 'no citation', sources: [] }] }],
    })).toThrow();
  });
});

describe('normaliseProjectsAgentOutput', () => {
  it('strips echoed sources off a live-shaped bulletId+sources payload (2 entries x 6 highlights) and the result passes the schema', () => {
    const makeEntry = (idx: number) => ({
      name: `Project${idx}`,
      github: `github.com/o/project${idx}`,
      description: '',
      highlights: Array.from({ length: 6 }, (_, i) => ({ bulletId: `p${idx}.b${i}`, sources: ['fact'] })),
    });
    const raw = { entries: [makeEntry(0), makeEntry(1)] };

    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);

    expect(normalisedExtras).toBe(12);
    const parsed = ProjectsAgentOutputSchema.parse(output);
    for (const entry of parsed.entries) {
      for (const highlight of entry.highlights) {
        expect(highlight).toEqual({ bulletId: expect.any(String) });
      }
    }
  });

  it('keeps a bulletId+text+sources item as curated -- bulletId only', () => {
    const raw = { entries: [{ name: 'X', github: '', description: '', highlights: [{ bulletId: 'p0.b0', text: 'echoed text', sources: ['p0.r0'] }] }] };

    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);

    expect(normalisedExtras).toBe(1);
    expect((output as { entries: Array<{ highlights: unknown[] }> }).entries[0]!.highlights).toEqual([{ bulletId: 'p0.b0' }]);
  });

  it('drops an unknown extra key off a composed item -- keeps text+sources only', () => {
    const raw = { entries: [{ name: 'X', github: '', description: '', highlights: [{ text: 'Configured DNS', sources: ['p0.r0'], confidence: 0.9 }] }] };

    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);

    expect(normalisedExtras).toBe(1);
    expect((output as { entries: Array<{ highlights: unknown[] }> }).entries[0]!.highlights).toEqual([{ text: 'Configured DNS', sources: ['p0.r0'] }]);
  });

  it('passes a neither-shape item through untouched -- the schema still rejects it', () => {
    const raw = { entries: [{ name: 'X', github: '', description: '', highlights: [{ note: 'x' }] }] };

    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);

    expect(normalisedExtras).toBe(0);
    expect((output as { entries: Array<{ highlights: unknown[] }> }).entries[0]!.highlights).toEqual([{ note: 'x' }]);
    expect(() => ProjectsAgentOutputSchema.parse(output)).toThrow();
  });

  it('discards an agent-emitted entry description and counts it', () => {
    const raw = { entries: [{ name: 'X', github: '', description: 'a model-authored pitch', highlights: [{ bulletId: 'p0.b0' }] }] };

    const { output, normalisedExtras } = normaliseProjectsAgentOutput(raw);

    expect(normalisedExtras).toBe(1);
    expect((output as { entries: Array<{ description: string }> }).entries[0]!.description).toBe('');
  });

  it('passes malformed raw input through unchanged with normalisedExtras 0', () => {
    expect(normaliseProjectsAgentOutput(null)).toEqual({ output: null, normalisedExtras: 0 });
    expect(normaliseProjectsAgentOutput('nope')).toEqual({ output: 'nope', normalisedExtras: 0 });
    expect(normaliseProjectsAgentOutput({ entries: 'nope' })).toEqual({ output: { entries: 'nope' }, normalisedExtras: 0 });
  });
});
