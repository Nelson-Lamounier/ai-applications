/** @format */
import { classifyConceptCoverage } from './concept-coverage-classify.js';

describe('classifyConceptCoverage', () => {
    it('classifies a canonical the user has concept_evidence for as covered', () => {
        const evidenced = new Set(['observability']);
        const ontology = new Set(['observability']);
        const out = classifyConceptCoverage('observability', evidenced, ontology, new Map());
        expect(out).toEqual({ classification: 'covered', canonical: 'observability' });
    });

    it('classifies a concept present in the ontology but with no evidence as uncovered', () => {
        const evidenced = new Set<string>();
        const ontology = new Set(['distributed systems']);
        const out = classifyConceptCoverage('distributed systems', evidenced, ontology, new Map());
        expect(out).toEqual({ classification: 'uncovered', canonical: 'distributed systems' });
    });

    it('classifies a concept absent from the ontology as unknown-concept, even when the raw string is present in evidenced (canonicalisation mismatch)', () => {
        const evidenced = new Set(['technical support']); // should never happen but proves the ontology gate wins
        const ontology = new Set<string>();
        const out = classifyConceptCoverage('technical support', evidenced, ontology, new Map());
        expect(out).toEqual({ classification: 'unknown-concept', canonical: 'technical support' });
    });

    it('resolves an alias to its canonical name before checking coverage (Map alias map)', () => {
        const evidenced = new Set(['observability']);
        const ontology = new Set(['observability']);
        const aliasMap = new Map([['monitoring', 'observability']]);
        const out = classifyConceptCoverage('Monitoring', evidenced, ontology, aliasMap);
        expect(out).toEqual({ classification: 'covered', canonical: 'observability' });
    });

    it('resolves an alias to its canonical name before checking coverage (Record alias map)', () => {
        const evidenced = new Set(['observability']);
        const ontology = new Set(['observability']);
        const aliasRecord = { monitoring: 'observability' };
        const out = classifyConceptCoverage('Monitoring', evidenced, ontology, aliasRecord);
        expect(out).toEqual({ classification: 'covered', canonical: 'observability' });
    });

    it('falls back to the lowercased, trimmed concept string when no alias entry exists', () => {
        const evidenced = new Set<string>();
        const ontology = new Set<string>();
        const out = classifyConceptCoverage('  Some Unmapped Concept  ', evidenced, ontology, new Map());
        expect(out.canonical).toBe('some unmapped concept');
        expect(out.classification).toBe('unknown-concept');
    });

    it('ontology membership is checked before coverage — evidence for a non-ontology canonical never claims covered', () => {
        const evidenced = new Set(['process automation']);
        const ontology = new Set(['distributed systems']); // does NOT include 'process automation'
        const out = classifyConceptCoverage('process automation', evidenced, ontology, new Map());
        expect(out.classification).toBe('unknown-concept');
    });
});
