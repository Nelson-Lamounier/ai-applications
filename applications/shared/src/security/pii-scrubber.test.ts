import { PiiScrubber } from './pii-scrubber.js';
import type { IPiiDetector, PiiSpan } from './pii-types.js';

describe('PiiScrubber', () => {
    it('redacts detected spans with default policy tokens', () => {
        const s = new PiiScrubber();
        const r = s.scrub('email jane@x.com and ip 10.0.0.1');
        expect(r.found).toBe(true);
        expect(r.redacted).toBe('email [EMAIL] and ip [IP]');
        expect(r.spans.map(x => x.type).sort((a, b) => a.localeCompare(b))).toEqual(['EMAIL', 'IP']);
    });

    it('returns input unchanged and found=false when no PII', () => {
        const r = new PiiScrubber().scrub('totally clean text');
        expect(r).toEqual({ redacted: 'totally clean text', spans: [], found: false });
    });

    it('handles adjacent spans without corrupting offsets', () => {
        const fake: IPiiDetector = {
            detect: (): PiiSpan[] => [
                { start: 0, end: 5, type: 'NAME', value: 'Alice' },
                { start: 6, end: 18, type: 'EMAIL', value: 'a@example.io' },
            ],
        };
        const r = new PiiScrubber({ detector: fake }).scrub('Alice a@example.io');
        expect(r.redacted).toBe('[NAME] [EMAIL]');
    });

    it('honours a custom redaction policy', () => {
        const r = new PiiScrubber({ policy: { EMAIL: '<<E>>', PHONE: '[PHONE]', SSN: '[SSN]', CREDIT_CARD: '[CC]', IP: '[IP]', NAME: '[NAME]' } })
            .scrub('a@b.com');
        expect(r.redacted).toBe('<<E>>');
    });

    describe('adversarial inputs (checklist section 5)', () => {
        const s = new PiiScrubber();
        it('redacts spaced/dashed SSN and credit card variants', () => {
            expect(s.scrub('ssn 123-45-6789').redacted).toBe('ssn [SSN]');
            expect(s.scrub('card 4111-1111-1111-1111').redacted).toBe('card [CC]');
            expect(s.scrub('card 4111 1111 1111 1111').redacted).toBe('card [CC]');
        });
        it('redacts email with plus-addressing and subdomains', () => {
            expect(s.scrub('a.b+tag@mail.corp.example.co').redacted).toBe('[EMAIL]');
        });
        it('flags IP only with 4 octets, not version strings', () => {
            expect(s.scrub('build 1.2.3 shipped').found).toBe(false);
            expect(s.scrub('host 192.168.1.10').found).toBe(true);
        });
        it('does not throw or corrupt on overlapping spans', () => {
            const fake: IPiiDetector = {
                detect: (): PiiSpan[] => [
                    { start: 0, end: 10, type: 'EMAIL', value: 'a@b.com xx' },
                    { start: 5, end: 8, type: 'IP', value: 'com' },
                ],
            };
            const r = new PiiScrubber({ detector: fake }).scrub('a@b.com xx');
            expect(typeof r.redacted).toBe('string');
            expect(r.found).toBe(true);
            expect(r.redacted).toBe('[EMAIL]x');
        });
    });
});
