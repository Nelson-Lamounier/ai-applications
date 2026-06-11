/** @format */
import type { JdExtraction } from '../agents/jd-extractor.js';
import type { StrategistResearchResult } from '@bedrock/shared';
import { collectJdMustHavesV2 } from './jd-keywords.js';

const EMPTY_INVENTORY = { infrastructure: [], tools: [], languages: [], frameworks: [], methodologies: [] };

const EMPTY_RESEARCH: StrategistResearchResult = {
    hardRequirements: [],
    softRequirements: [],
    preferredQualifications: [],
    technologyInventory: EMPTY_INVENTORY,
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    transferableStrengths: [],
    positioningAngle: '',
    redFlags: [],
    salaryBenchmark: { currency: 'USD', low: 0, mid: 0, high: 0, source: '' },
} as unknown as StrategistResearchResult;

const RESEARCH_WITH_TERMS: StrategistResearchResult = {
    ...EMPTY_RESEARCH,
    hardRequirements: [{ skill: 'Kubernetes', context: '' }],
    technologyInventory: {
        ...EMPTY_INVENTORY,
        infrastructure: ['AWS'],
        tools: ['Terraform'],
    },
} as unknown as StrategistResearchResult;

const JD: JdExtraction = {
    requiredSkills: ['incident response', 'on-call rotation'],
    preferredSkills: [],
    tools: ['Datadog', 'PagerDuty'],
    concepts: ['observability', 'SLO'],
    responsibilities: [],
    domain: 'SRE',
    seniority: 'senior',
    retrievalKeywords: [],
};

describe('collectJdMustHavesV2', () => {
    it('returns atomic JD extractor terms when jd is present', () => {
        const result = collectJdMustHavesV2(JD, EMPTY_RESEARCH);
        expect(result).toContain('incident response');
        expect(result).toContain('Datadog');
        expect(result).toContain('observability');
        // research fallback terms NOT included when jd present
        expect(result).not.toContain('Kubernetes');
    });

    it('falls back to research terms when jd is null', () => {
        const result = collectJdMustHavesV2(null, RESEARCH_WITH_TERMS);
        expect(result).toContain('Kubernetes');
        expect(result).toContain('AWS');
        expect(result).toContain('Terraform');
    });

    it('caps output at 18 terms', () => {
        const bigJd: JdExtraction = {
            ...JD,
            requiredSkills: Array.from({ length: 10 }, (_, i) => `skill${i}`),
            tools: Array.from({ length: 8 }, (_, i) => `tool${i}`),
            concepts: Array.from({ length: 5 }, (_, i) => `concept${i}`),
        };
        const result = collectJdMustHavesV2(bigJd, EMPTY_RESEARCH);
        expect(result.length).toBe(18);
    });

    it('falls back when jd has empty arrays across all three fields', () => {
        const emptyJd: JdExtraction = { ...JD, requiredSkills: [], tools: [], concepts: [] };
        const result = collectJdMustHavesV2(emptyJd, RESEARCH_WITH_TERMS);
        expect(result).toContain('Kubernetes');
    });
});
