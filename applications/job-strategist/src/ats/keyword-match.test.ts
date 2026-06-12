/** @format */
import { normalizeTerm, matchTier1, matchTerm } from './keyword-match.js';

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

    it('skill-category: generic language/scripting terms credited when the resume lists a concrete language', () => {
        const r = 'Support engineer; Python and Bash automation; AWS CLI';
        expect(matchTier1('scripting languages', r)).toBe(true);          // → "languages" + resume has Python
        expect(matchTier1('Programming languages', r)).toBe(true);
        expect(matchTier1('Scripting or code automation', r)).toBe(true); // 'scripting' cue + Python
    });
    it('skill-category honesty: a real gap with no language cue stays a miss', () => {
        const r = 'Support engineer; Python and Bash automation';
        expect(matchTier1('AI-driven customer support automation', r)).toBe(false); // no language/scripting cue
        expect(matchTier1('scripting languages', 'recruiter with no technical skills')).toBe(false); // no language in resume
    });
});

const r2 = 'support engineer; escalation management and sla ownership; python automation; aws iam';
const familyVocab = [['escalation', 'sla', 'on-call', 'incident response', 'root cause analysis']];

describe('matchTerm (3 tiers)', () => {
    it('tier literal — raw term present', async () => {
        const res = await matchTerm('python', r2, { familyVocab, embedder: null, threshold: 0.55 });
        expect(res.present).toBe(true); expect(res.tier).toBe('literal');
    });
    it('tier normalized — Tier 1 normalized/token', async () => {
        const res = await matchTerm('SLA ownership skills', r2, { familyVocab: [], embedder: null, threshold: 0.55 });
        expect(res.present).toBe(true); expect(res.tier).toBe('normalized');
    });
    it('tier ontology — JD term in a family vocab group + resume has another vocab term from that group', async () => {
        // "incident response" not literally in resume, but "escalation"/"sla" are (same family group)
        const res = await matchTerm('incident response', r2, { familyVocab, embedder: null, threshold: 0.55 });
        expect(res.present).toBe(true); expect(res.tier).toBe('ontology');
    });
    it('tier embedding — conservative semantic match when literal+ontology miss', async () => {
        const embedder = { embed: jest.fn()
            .mockResolvedValueOnce([1, 0, 0])     // resume vector (first embed call)
            .mockResolvedValueOnce([0.9, 0.1, 0]) // term vector (cosine ~0.99 >= 0.55)
        };
        const res = await matchTerm('customer ticket triage', r2, { familyVocab: [], embedder, threshold: 0.55 });
        expect(res.present).toBe(true); expect(res.tier).toBe('embedding');
    });
    it('none — genuine gap, below embedding threshold', async () => {
        const embedder = { embed: jest.fn().mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 0]) }; // cosine 0
        const res = await matchTerm('ChatGPT', r2, { familyVocab: [], embedder, threshold: 0.55 });
        expect(res.present).toBe(false); expect(res.tier).toBe('none');
    });
    it('embedder error → fail-open, no false credit', async () => {
        const embedder = { embed: jest.fn().mockRejectedValue(new Error('down')) };
        const res = await matchTerm('ChatGPT', r2, { familyVocab: [], embedder, threshold: 0.55 });
        expect(res.present).toBe(false); expect(res.tier).toBe('none');
    });
    it('no embedder → tiers 1-2 only', async () => {
        const res = await matchTerm('ChatGPT', r2, { familyVocab: [], embedder: null, threshold: 0.55 });
        expect(res.present).toBe(false); expect(res.tier).toBe('none');
    });
});
