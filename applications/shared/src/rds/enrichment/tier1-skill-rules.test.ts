/** @format */
import { tier1SkillsFromTech } from './tier1-skill-rules.js';

const map = new Map<string, readonly string[]>([
    ['aws_cdk', ['aws cdk', 'infrastructure as code']],
    ['jest', ['jest', 'automated testing']],
    ['calico', ['calico', 'kubernetes networking']],
    ['react', ['react', 'react development']],
]);

describe('tier1SkillsFromTech', () => {
    it('maps each file tech to its tool + implied capability skills', () => {
        expect(tier1SkillsFromTech(['aws_cdk'], map).sort((a, b) => a.localeCompare(b)))
            .toEqual(['aws cdk', 'infrastructure as code']);
    });

    it('unions + dedupes skills across several technologies', () => {
        const out = tier1SkillsFromTech(['aws_cdk', 'jest'], map);
        expect(out).toEqual(expect.arrayContaining(['aws cdk', 'infrastructure as code', 'jest', 'automated testing']));
        expect(out).toHaveLength(4);
    });

    it('is case-insensitive on the tech name', () => {
        expect(tier1SkillsFromTech(['AWS_CDK'], map)).toEqual(['aws cdk', 'infrastructure as code']);
    });

    it('returns [] for a tech with no mapping (chunk stays residual for later tiers)', () => {
        expect(tier1SkillsFromTech(['some_unmapped_tech'], map)).toEqual([]);
    });

    it('returns [] for a chunk with no file_tech_stack', () => {
        expect(tier1SkillsFromTech([], map)).toEqual([]);
    });

    it('emits only canonical skills from the map (no raw tech leakage)', () => {
        const out = tier1SkillsFromTech(['calico'], map);
        expect(out).toEqual(['calico', 'kubernetes networking']);
        expect(out).not.toContain('calico_networking');
    });
});
