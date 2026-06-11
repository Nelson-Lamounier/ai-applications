/** @format */
import { normalizeTerm, matchTier1 } from './keyword-match.js';

describe('normalizeTerm', () => {
    it('strips qualifiers + generic suffixes, collapses punctuation', () => {
        expect(normalizeTerm('Expert-level SaaS troubleshooting skills')).toBe('saas troubleshooting');
        expect(normalizeTerm('Python scripting')).toBe('python');
        expect(normalizeTerm('Support ticketing systems (implied)')).toBe('support ticketing');
        expect(normalizeTerm('root cause analysis')).toBe('root cause analysis');
    });
});

describe('matchTier1', () => {
    const resume =
        'Support engineer with Python and Bash automation; root-cause analysis across AWS IAM; runbook authoring';

    it('normalized substring is hyphen/space agnostic', () => {
        expect(matchTier1('root cause analysis', resume)).toBe(true); // resume has "root-cause analysis"
    });

    it('reduces a multi-word skill to its core (Python scripting -> python present)', () => {
        expect(matchTier1('Python scripting', resume)).toBe(true);
    });

    it('atomic present term matches', () => {
        expect(matchTier1('AWS', resume)).toBe(true);
    });

    it('genuine gap returns false', () => {
        expect(matchTier1('ChatGPT', resume)).toBe(false);
        expect(matchTier1('OpenAI API', resume)).toBe(false);
    });
});
