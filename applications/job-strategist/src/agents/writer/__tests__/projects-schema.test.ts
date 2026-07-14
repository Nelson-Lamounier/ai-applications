/** @format */
import { describe, it, expect } from '@jest/globals';
import { ProjectsAgentOutputSchema, isCurated } from '../projects-schema.js';

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
