/** @format */
import { canonicalJdSkills } from '../canonical-jd-skills.js';

describe('canonicalJdSkills', () => {
    it('unions required + technology inventory + preferred, required/inventory first', () => {
        const out = canonicalJdSkills({
            requiredSkills: ['Python', 'SaaS troubleshooting'],
            preferredSkills: ['Terraform'],
            technologyInventory: { tools: ['OpenAI API'], languages: ['TypeScript'], infrastructure: ['AWS'] },
        });
        expect(out).toEqual(['Python', 'SaaS troubleshooting', 'OpenAI API', 'TypeScript', 'AWS', 'Terraform']);
    });

    it('dedupes case-insensitively, first occurrence wins', () => {
        const out = canonicalJdSkills({
            requiredSkills: ['Python', 'python'],
            technologyInventory: { languages: ['PYTHON'] },
            tools: ['Python'],
        });
        expect(out).toEqual(['Python']);
    });

    it('drops empty/whitespace entries', () => {
        const out = canonicalJdSkills({ requiredSkills: ['', '  ', 'Docker'], technologyInventory: { tools: ['  '] } });
        expect(out).toEqual(['Docker']);
    });

    it('handles a fully empty signal', () => {
        expect(canonicalJdSkills({})).toEqual([]);
        expect(canonicalJdSkills({ requiredSkills: [], technologyInventory: {} })).toEqual([]);
    });

    it('includes legacy flat tools + methodologies', () => {
        const out = canonicalJdSkills({
            requiredSkills: ['A'],
            tools: ['B'],
            technologyInventory: { methodologies: ['Agile'] },
        });
        expect(out).toEqual(['A', 'Agile', 'B']);
    });
});
