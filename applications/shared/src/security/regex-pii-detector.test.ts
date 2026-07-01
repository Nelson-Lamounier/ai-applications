import { RegexPiiDetector } from './regex-pii-detector.js';

describe('RegexPiiDetector', () => {
    const d = new RegexPiiDetector();

    it('detects an email with correct span and type', () => {
        const text = 'reach me at jane.doe@example.com today';
        const spans = d.detect(text);
        expect(spans).toHaveLength(1);
        expect(spans[0].type).toBe('EMAIL');
        expect(spans[0].value).toBe('jane.doe@example.com');
        expect(text.slice(spans[0].start, spans[0].end)).toBe('jane.doe@example.com');
    });

    it('detects phone, SSN, credit card, and IPv4', () => {
        const text = 'call 415-555-2671, ssn 123-45-6789, cc 4111 1111 1111 1111, ip 10.0.0.1';
        expect(d.detect(text)).toHaveLength(4);
        const types = d.detect(text).map(s => s.type).sort((a, b) => a.localeCompare(b));
        expect(types).toEqual(['CREDIT_CARD', 'IP', 'PHONE', 'SSN']);
    });

    it('detects a NAME via name-context heuristic only', () => {
        const spans = d.detect('Name: Nelson Lamounier');
        expect(spans.some(s => s.type === 'NAME' && s.value === 'Nelson Lamounier')).toBe(true);
        expect(d.detect('Cloud Engineering team').some(s => s.type === 'NAME')).toBe(false);
        expect(d.detect('CANDIDATE: John Smith').some(s => s.type === 'NAME')).toBe(true);
    });

    it('is case-sensitive on the bigram — lower-case words after a trigger are not a NAME', () => {
        // The `i` flag once collapsed the Title-case bigram into "any two words".
        expect(d.detect('name: john smith').some(s => s.type === 'NAME')).toBe(false);
    });

    it('does not redact technical prose after "by" (article-pipeline regression)', () => {
        // Real bug: "rotated by EKS Pod Identity" became "rotated by [NAME] Identity"
        // because `by` was a trigger and `gi` made [A-Z][a-z]+ match any case.
        expect(d.detect('rotated automatically by EKS Pod Identity').some(s => s.type === 'NAME')).toBe(false);
        expect(d.detect('a dev-shutdown Lambda triggered by Karpenter Nodepools').some(s => s.type === 'NAME')).toBe(false);
        // "name" trigger followed by a lower-case phrase must also survive.
        expect(d.detect('store the ARN or resource name in SSM').some(s => s.type === 'NAME')).toBe(false);
    });

    it('returns spans in ascending start order and [] for clean text', () => {
        expect(d.detect('no pii here')).toEqual([]);
        const spans = d.detect('a@b.com then 10.0.0.1');
        expect(spans[0].start).toBeLessThan(spans[1].start);
    });
});
