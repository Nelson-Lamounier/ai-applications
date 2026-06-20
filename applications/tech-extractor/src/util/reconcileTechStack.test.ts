/** @format */
import { diffTechSets } from './reconcileTechStack.js';

describe('diffTechSets', () => {
    // alias map: lowercased alias/canonical -> canonical_name (lowercased)
    const aliases = new Map<string, string>([
        ['react', 'react'],
        ['react.js', 'react'],
        ['reactjs', 'react'],
        ['vue', 'vue'],
        ['postgresql', 'postgresql'],
        ['postgres', 'postgresql'],
    ]);
    const evidence = [
        { canonical: 'react', display: 'React' },
        { canonical: 'postgresql', display: 'PostgreSQL' },
    ];

    it('verifies a profile term that resolves (via alias) to an evidenced canonical', () => {
        const r = diffTechSets(evidence, ['React.js', 'postgres'], aliases);
        expect(r.reconciled).toEqual(['PostgreSQL', 'React']);   // evidence-backed display names
        expect(r.llmOnly).toEqual([]);                            // both resolved + evidenced
        expect(r.evidenceOnly).toEqual([]);                       // all evidence claimed
    });

    it('flags a claimed tech with no file evidence as llmOnly', () => {
        const r = diffTechSets(evidence, ['React', 'Vue'], aliases);
        expect(r.llmOnly).toEqual(['Vue']);                       // Vue resolves but has no evidence
        expect(r.evidenceOnly).toEqual(['PostgreSQL']);           // evidenced but LLM didn't claim it
        expect(r.reconciled).toEqual(['PostgreSQL', 'React']);
    });

    it('flags an unknown (un-ontologised) claim as llmOnly too', () => {
        const r = diffTechSets(evidence, ['React', 'SomeInventedFramework'], aliases);
        expect(r.llmOnly).toEqual(['SomeInventedFramework']);
    });

    it('reports evidenceOnly when the LLM missed an evidenced tech', () => {
        const r = diffTechSets(evidence, ['react'], aliases);
        expect(r.evidenceOnly).toEqual(['PostgreSQL']);
        expect(r.llmOnly).toEqual([]);
    });

    it('dedupes + trims profile terms, ignores blanks/non-strings', () => {
        const r = diffTechSets(evidence, ['  React ', 'reactjs', '', 'Vue'] as string[], aliases);
        expect(r.llmOnly).toEqual(['Vue']);                       // React variants collapse + verified
    });
});
