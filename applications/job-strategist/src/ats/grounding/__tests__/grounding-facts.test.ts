/** @format */
import { buildGroundingFacts } from '../grounding-facts.js';
import { extractNumbers } from '../number-provenance.js';

describe('buildGroundingFacts', () => {
    it('joins non-empty parts with a blank line', () => {
        expect(buildGroundingFacts(['a', 'b'])).toBe('a\n\nb');
    });

    it('drops empty/falsy parts', () => {
        expect(buildGroundingFacts(['a', '', 'b'])).toBe('a\n\nb');
    });

    it('empty input → empty string', () => {
        expect(buildGroundingFacts([])).toBe('');
    });
});

describe('buildGroundingFacts — F2 (allowed-number set from verbatim evidence only)', () => {
    it('does not admit a number that appears only in free-text sourceCitation', () => {
        // Matcher's paraphrased sourceCitation ("cut deploy time 40%") is NOT
        // verbatim KB text and must never be passed as a part — only verbatim
        // blocks are: verified career facts + the grounded-metrics block (which
        // carries researchData.quantifiedEvidence, instructed verbatim from KB).
        const research = {
            verifiedMatches: [{ skill: 'CI/CD', sourceCitation: 'cut deploy time 40% (paraphrase)' }],
            quantifiedEvidence: ['deployed to 3 regions'],
        };
        const experienceFactsBlock = 'Verified employer: Acme (2020-2024).';
        const groundedMetricsBlock = research.quantifiedEvidence.join('\n');

        // Mirrors the fixed run-pipeline.ts call sites: sourceCitation is
        // deliberately excluded from the parts array.
        const assembled = buildGroundingFacts([experienceFactsBlock, groundedMetricsBlock]);
        const allowed = extractNumbers(assembled);

        expect(allowed.has(40)).toBe(false);
        expect(allowed.has(3)).toBe(true);
    });

    it('regression guard: the offending shape (sourceCitation folded in) WOULD have admitted 40', () => {
        // Documents the bug this fix removes: if a caller mistakenly re-adds
        // researchData.verifiedMatches.map(m => `${m.skill}: ${m.sourceCitation}`)
        // as a part, the paraphrased number launders into the allowed set.
        const sourceCitationProse = 'CI/CD: cut deploy time 40% (paraphrase)';
        const assembled = buildGroundingFacts(['Verified employer: Acme (2020-2024).', sourceCitationProse]);
        expect(extractNumbers(assembled).has(40)).toBe(true);
    });
});
