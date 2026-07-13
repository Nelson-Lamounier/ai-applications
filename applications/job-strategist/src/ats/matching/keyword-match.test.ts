/** @format */
import { normalizeTerm, matchTier1, matchTerm, matchTechTransfer, tokenOverlapMatch } from './keyword-match.js';

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

describe('matchTier1 — proximity for multi-word terms (F4)', () => {
    it('does NOT match when tokens appear in unrelated sentences', () => {
        expect(matchTier1('project management',
            'Shipped a side project last year. Handled stakeholder time management separately.')).toBe(false);
    });
    it('DOES match when the tokens co-occur as the actual phrase/skill', () => {
        expect(matchTier1('project management', 'led project management for a 6-person team')).toBe(true);
        expect(matchTier1('aws', 'deployed on aws')).toBe(true); // single-token unaffected
    });
    it('matches when tokens co-occur in the same sentence but are not adjacent (within window)', () => {
        expect(matchTier1('project management',
            'led the project through several phases of stakeholder management')).toBe(true);
    });
});

describe('tokenOverlapMatch', () => {
    it('≥2 shared significant tokens → true (bridges competency phrasing)', () => {
        // shares {root, cause, analysis}
        expect(tokenOverlapMatch(
            'Critical thinking and root cause analysis',
            'SaaS support operations, escalation management, root-cause analysis',
        )).toBe(true);
    });

    it('exactly 2 shared tokens → true', () => {
        // {customer, support} shared
        expect(tokenOverlapMatch(
            'Direct customer support and relationship building',
            'Direct customer support / customer interaction',
        )).toBe(true);
    });

    it('1 shared token → false (unless ≥60% of smaller set)', () => {
        // 'payment systems' → {payment}; 'payment gateway integration' → {payment, gateway, integration}
        // 1 shared / min(1,3) = 100% of the smaller set → true by the 60% rule
        expect(tokenOverlapMatch('payment systems', 'fraud detection pipeline', 2)).toBe(false);
    });

    it('1 shared token, larger disjoint sets → false', () => {
        // {customer, retention} vs {customer, acquisition, funnel, analytics} → 1 shared, 1/2 = 50% < 60% → false
        expect(tokenOverlapMatch('customer retention', 'customer acquisition funnel analytics')).toBe(false);
    });

    it('1 shared token but ≥60% of smaller set → true', () => {
        // {alerting} vs {alerting, dashboards} → 1 shared, 1/min(1,2)=100% ≥ 60% → true
        expect(tokenOverlapMatch('alerting', 'alerting dashboards')).toBe(true);
    });

    it('disjoint sets → false', () => {
        expect(tokenOverlapMatch('Salesforce CRM', 'Kubernetes orchestration')).toBe(false);
    });

    it('empty token set on either side → false', () => {
        expect(tokenOverlapMatch('', 'root cause analysis')).toBe(false);
        expect(tokenOverlapMatch('and or the', 'root cause analysis')).toBe(false);
    });
});

describe('tokenOverlapMatch — dropped-short-token guard (F1)', () => {
    it('does NOT match when a multi-word term collapses to a single token via the <3-char cut', () => {
        // "AI Engineering" -> {engineering} after the <3-char "ai" is dropped;
        // must NOT then match any string containing "engineering".
        expect(tokenOverlapMatch('AI Engineering', 'Data Engineering Pipelines')).toBe(false);
        expect(tokenOverlapMatch('ML Ops', 'Cloud Ops team')).toBe(false);
    });

    it('generalises beyond any fixed word list — ANY generic noun left after the short token drops', () => {
        // These generic nouns (automation, reporting, governance) were never on the old
        // hardcoded allowlist — the guard must still close the hole for them, since no
        // fixed list can enumerate every generic noun a short acronym might leave behind.
        expect(tokenOverlapMatch('AI Automation', 'Data Automation Pipelines')).toBe(false);
        expect(tokenOverlapMatch('UX Reporting', 'Data Reporting Dashboard')).toBe(false);
        expect(tokenOverlapMatch('ML Governance', 'Cloud Governance Team')).toBe(false);
    });

    it('still matches a genuine multi-token overlap (no short token was dropped)', () => {
        expect(tokenOverlapMatch('root cause analysis', 'performed root-cause analysis on incidents')).toBe(true);
        expect(tokenOverlapMatch('incident response', 'handled incident response on-call')).toBe(true);
        expect(tokenOverlapMatch('data engineering', 'built data engineering pipelines')).toBe(true);
        expect(tokenOverlapMatch('customer support', 'provided customer support')).toBe(true);
    });

    it('a genuinely single-word term still bridges via the ratio rule (no token was ever dropped)', () => {
        expect(tokenOverlapMatch('alerting', 'alerting dashboards')).toBe(true);
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

// ---------------------------------------------------------------------------
// A3 — tech-transfer tier
// ---------------------------------------------------------------------------

// Tech group: all these canoncials are mutually transferable AI/LLM providers
const aiProviderGroup = ['anthropic_claude', 'openai', 'aws_bedrock', 'chatgpt', 'codex'];

// Alias map: JD terms / display forms → canonical names (lowercased keys)
const aiAliasMap = new Map<string, string>([
    ['openai api', 'openai'],
    ['openai', 'openai'],
    ['chatgpt', 'chatgpt'],
    ['codex', 'codex'],
    ['anthropic claude', 'anthropic_claude'],
    ['claude', 'anthropic_claude'],
    ['aws bedrock', 'aws_bedrock'],
    ['bedrock', 'aws_bedrock'],
    ['amazon bedrock', 'aws_bedrock'],
]);

const techGroups = [aiProviderGroup];

describe('matchTechTransfer', () => {
    it('JD "OpenAI API" + resume mentions "AWS Bedrock" (group sibling) → true', () => {
        const resume = 'i built integrations using aws bedrock for llm inference';
        expect(matchTechTransfer('OpenAI API', resume, techGroups, aiAliasMap)).toBe(true);
    });

    it('JD "OpenAI API" + resume mentions "Claude" (alias of anthropic_claude, group sibling) → true', () => {
        const resume = 'i used claude to draft customer emails';
        expect(matchTechTransfer('OpenAI API', resume, techGroups, aiAliasMap)).toBe(true);
    });

    it('JD "OpenAI API" + resume has NO group sibling → false', () => {
        const resume = 'i built restful services in python with no llm tooling';
        expect(matchTechTransfer('OpenAI API', resume, techGroups, aiAliasMap)).toBe(false);
    });

    it('JD term not in any tech group → false (no false credit)', () => {
        const resume = 'salesforce crmanalytics and openai api usage';
        expect(matchTechTransfer('Salesforce', resume, techGroups, aiAliasMap)).toBe(false);
    });

    it('canonical display form (underscore→space) is also checked against resume', () => {
        // 'anthropic_claude' display = 'anthropic claude'; resume has it literally
        const resume = 'built workflows with anthropic claude via api';
        expect(matchTechTransfer('OpenAI API', resume, techGroups, aiAliasMap)).toBe(true);
    });
});

describe('matchTerm — tech-transfer tier (A3)', () => {
    const noEmbedder = { familyVocab: [], embedder: null as null, threshold: 0.55 };

    it('resolves tier tech-transfer when ontology misses but group sibling is in resume', async () => {
        const resume = 'integrated aws bedrock for llm inference across multiple microservices';
        const res = await matchTerm('OpenAI API', resume, {
            ...noEmbedder,
            techGroups,
            techAliasMap: aiAliasMap,
        });
        expect(res.present).toBe(true);
        expect(res.tier).toBe('tech-transfer');
    });

    it('tech-transfer is skipped when ontology already fires — ontology wins', async () => {
        // ontology family includes both terms; tech-transfer should not interfere
        const ontVocab = [['openai', 'aws bedrock']];
        const resume = 'aws bedrock usage in production';
        const res = await matchTerm('openai', resume, {
            ...noEmbedder,
            familyVocab: ontVocab,
            techGroups,
            techAliasMap: aiAliasMap,
        });
        expect(res.present).toBe(true);
        expect(res.tier).toBe('ontology');
    });

    it('omitting techGroups + techAliasMap leaves existing tiers unaffected (back-compat)', async () => {
        // resume has no literal/normalized match and no ontology group → none
        const res = await matchTerm('OpenAI API', 'python and bash scripting', noEmbedder);
        expect(res.present).toBe(false);
        expect(res.tier).toBe('none');
    });

    it('genuine gap with no group sibling → none (honesty)', async () => {
        const resume = 'salesforce crm and excel reporting';
        const res = await matchTerm('OpenAI API', resume, {
            ...noEmbedder,
            techGroups,
            techAliasMap: aiAliasMap,
        });
        expect(res.present).toBe(false);
        expect(res.tier).toBe('none');
    });
});
