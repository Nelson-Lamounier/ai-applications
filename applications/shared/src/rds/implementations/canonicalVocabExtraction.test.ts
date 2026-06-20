/** @format */
import {
    buildCanonicalExtractionBody,
    parseCanonicalSkills,
    ENRICH_CANONICAL_SYSTEM_PROMPT,
} from './canonicalVocabExtraction.js';

describe('buildCanonicalExtractionBody', () => {
    it('puts the controlled vocabulary in the system prefix + forces the tool', () => {
        const body = buildCanonicalExtractionBody(['kubernetes', 'terraform'], 'a.ts', 'body') as Record<string, unknown>;
        const system = body.system as string;
        expect(system).toContain(ENRICH_CANONICAL_SYSTEM_PROMPT);
        expect(system).toContain('CONTROLLED VOCABULARY (2 terms');
        expect(system).toContain('kubernetes');
        expect(system).toContain('terraform');
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_extraction' });
    });
});

describe('parseCanonicalSkills', () => {
    const vocab = new Set(['kubernetes', 'infrastructure as code', 'argocd']);

    it('keeps only in-vocabulary terms as canonical', () => {
        const r = parseCanonicalSkills(['kubernetes', 'argocd'], vocab);
        expect(r.canonical.sort((a, b) => a.localeCompare(b))).toEqual(['argocd', 'kubernetes']);
        expect(r.newSkills).toEqual([]);
    });

    it('routes an explicit NEW: term to the growth queue (prefix stripped)', () => {
        const r = parseCanonicalSkills(['kubernetes', 'NEW: webassembly'], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['webassembly']);
    });

    it('routes an off-vocab term WITHOUT the prefix to NEW (never pollutes canonical)', () => {
        const r = parseCanonicalSkills(['iac with cdk', 'kubernetes'], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['iac with cdk']);   // not in vocab -> gap, not a corpus skill
    });

    it('lowercases, trims, dedupes, drops empties/non-strings', () => {
        const r = parseCanonicalSkills(['  Kubernetes ', 'kubernetes', '', 42, 'NEW:  Rust '], vocab);
        expect(r.canonical).toEqual(['kubernetes']);
        expect(r.newSkills).toEqual(['rust']);
    });
});
