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

    it('honesty: short atomic term is word-bounded (Go does NOT match "going")', () => {
        expect(matchTier1('Go', 'ongoing background work in a good team')).toBe(false);
        expect(matchTier1('Go', 'wrote services in Go and Python')).toBe(true);
        expect(matchTier1('API', 'rapid deployment pipeline')).toBe(false);
    });

    it('honesty: 2-char atomic skill matches its own word (ML)', () => {
        expect(matchTier1('ML', 'built ML inference pipelines')).toBe(true);
    });

    it('honesty: soft-skill content word is required, not stripped (project management)', () => {
        expect(matchTier1('project management', 'shipped a side project last year')).toBe(false);
        expect(matchTier1('project management', 'project management of a 5-person team')).toBe(true);
    });
});
