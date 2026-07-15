/** @format */
import { describe, it, expect } from '@jest/globals';
import { SkillsAgentOutputSchema } from '../skills-schema.js';

describe('SkillsAgentOutputSchema', () => {
  it('accepts a valid skills payload -- categories of skill-name arrays', () => {
    const out = SkillsAgentOutputSchema.parse({
      skills: [
        { category: 'Languages', skills: ['Python', 'TypeScript'] },
        { category: 'Infrastructure', skills: ['Kubernetes', 'Terraform'] },
      ],
    });
    expect(out.skills).toHaveLength(2);
    expect(out.skills[0]!.category).toBe('Languages');
    expect(out.skills[0]!.skills).toEqual(['Python', 'TypeScript']);
  });

  it('accepts an empty skills array', () => {
    expect(SkillsAgentOutputSchema.parse({ skills: [] }).skills).toEqual([]);
  });

  it('rejects a category entry missing the skills array', () => {
    expect(() => SkillsAgentOutputSchema.parse({ skills: [{ category: 'Languages' }] })).toThrow();
  });

  it('rejects a category entry missing the category name', () => {
    expect(() => SkillsAgentOutputSchema.parse({ skills: [{ skills: ['Python'] }] })).toThrow();
  });

  it('rejects a non-array skills field at the top level', () => {
    expect(() => SkillsAgentOutputSchema.parse({ skills: 'nope' })).toThrow();
  });

  it('rejects a skill item that is not a string', () => {
    expect(() => SkillsAgentOutputSchema.parse({ skills: [{ category: 'Languages', skills: [42] }] })).toThrow();
  });
});
