/** @format */
import { jdAtsKeywords } from './jd-keywords-union.js';

describe('jdAtsKeywords', () => {
    it('unions requiredSkills, tools, retrievalKeywords; dedupes and drops blanks', () => {
        const out = jdAtsKeywords({ requiredSkills: ['IAM', 'TypeScript'], tools: ['IAM', 'Terraform'], retrievalKeywords: ['terraform', '', '  '] });
        expect(out).toEqual(expect.arrayContaining(['IAM', 'TypeScript', 'Terraform', 'terraform']));
        expect(out.filter((k) => k === 'IAM')).toHaveLength(1);     // deduped
        expect(out.some((k) => k.trim() === '')).toBe(false);       // no blanks
    });
    it('returns [] when all fields are empty', () => {
        expect(jdAtsKeywords({ requiredSkills: [], tools: [], retrievalKeywords: [] })).toEqual([]);
    });
});
