import { PiiScrubber } from './pii-scrubber.js';
import type { IPiiDetector, PiiSpan } from './pii-types.js';

describe('PiiScrubber', () => {
    it('redacts detected spans with default policy tokens', () => {
        const s = new PiiScrubber();
        const r = s.scrub('email jane@x.com and ip 10.0.0.1');
        expect(r.found).toBe(true);
        expect(r.redacted).toBe('email [EMAIL] and ip [IP]');
        expect(r.spans.map(x => x.type).sort()).toEqual(['EMAIL', 'IP']);
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
});
