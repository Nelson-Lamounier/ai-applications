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
        const types = d.detect(text).map(s => s.type).sort();
        expect(types).toEqual(['CREDIT_CARD', 'IP', 'PHONE', 'SSN']);
    });

    it('detects a NAME via name-context heuristic only', () => {
        const spans = d.detect('Name: Nelson Lamounier');
        expect(spans.some(s => s.type === 'NAME' && s.value === 'Nelson Lamounier')).toBe(true);
        expect(d.detect('Cloud Engineering team').some(s => s.type === 'NAME')).toBe(false);
        expect(d.detect('CANDIDATE: John Smith').some(s => s.type === 'NAME')).toBe(true);
    });

    it('returns spans in ascending start order and [] for clean text', () => {
        expect(d.detect('no pii here')).toEqual([]);
        const spans = d.detect('a@b.com then 10.0.0.1');
        expect(spans[0].start).toBeLessThan(spans[1].start);
    });
});
