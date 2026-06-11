/** @format */
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult, BasePipelineContext } from '@bedrock/shared';

// ---------------------------------------------------------------------------
// Module-scope helpers (used by both describe blocks)
// ---------------------------------------------------------------------------

function ats(present: number, total: number): AtsCheckResult {
    const cov = Array.from({ length: total }, (_, i) => ({ term: `k${i}`, present: i < present, grounded: false }));
    return {
        machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
        parseBreakers: [], jdKeywordCoverage: cov, status: 'passed', passed: true, issues: [],
    };
}
function research(verified: string[], gaps: string[], hardReqs: string[]): Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'> {
    return {
        verifiedMatches: verified.map((skill) => ({ skill, sourceCitation: '', depth: 'working' as const, recency: '' })),
        gaps:            gaps.map((skill) => ({ skill, gapType: 'hard' as const, impactSeverity: 'significant' as const, disqualifyingAssessment: '' })),
        hardRequirements: hardReqs.map((skill) => ({ skill, context: '' })),
    };
}

// ---------------------------------------------------------------------------
// Mock @bedrock/shared before importing the module under test
// ---------------------------------------------------------------------------

const mockRunAgent = jest.fn();

jest.mock('@bedrock/shared', () => ({
    runAgent: mockRunAgent,
    log: () => undefined,
}));

import { computeBaselineScore, buildRecruiterSnapshot } from './recruiter-snapshot.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeBaselineScore', () => {
    it('weights coverage 0.5, verified-ratio 0.3, hard-req-hit 0.2', () => {
        // coverage 6/10=0.6 ; verified 6/(6+4)=0.6 ; hardReqHit: 1 of 2 in verified = 0.5
        const r = research(['AWS', 'K8s', 'a', 'b', 'c', 'd'], ['g1', 'g2', 'g3', 'g4'], ['AWS', 'Terraform']);
        // 100*(0.5*0.6 + 0.3*0.6 + 0.2*0.5) = 100*(0.30+0.18+0.10) = 58
        expect(computeBaselineScore(r, ats(6, 10))).toBe(58);
    });

    it('hard-req-hit is 1 when there are no hard requirements', () => {
        const r = research(['x'], [], []);
        // coverage 1 ; verified 1/1=1 ; hardReqHit 1 → 100
        expect(computeBaselineScore(r, ats(4, 4))).toBe(100);
    });

    it('returns 0 when nothing matches', () => {
        const r = research([], ['g1'], ['AWS']);
        expect(computeBaselineScore(r, ats(0, 5))).toBe(0);
    });

    it('treats empty keyword coverage list as 0% coverage', () => {
        const r = research(['AWS'], [], []);
        // cov.length===0 → keywordCoverage=0 ; verified 1/1=1 ; hardReqHit 1
        // 100*(0.5*0 + 0.3*1 + 0.2*1) = 50
        expect(computeBaselineScore(r, ats(0, 0))).toBe(50);
    });
});

describe('buildRecruiterSnapshot', () => {
    const CTX: BasePipelineContext = {
        pipelineId: 'p',
        environment: 'dev',
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    it('applies the LLM delta to the baseline (clamped) and passes through keywords/flags', async () => {
        mockRunAgent.mockResolvedValue({
            data: {
                scoreDelta: 8,
                scoreRationale: 'strong infra fit',
                missingKeywords: ['Kafka', 'gRPC'],
                redFlags: [{ flag: 'No streaming', why: 'JD centres on Kafka' }],
            },
        });
        // baseline for research(['AWS'],['Kafka'],['AWS']) + ats(2,4):
        // cov .5, verified 1/2=.5, hardReqHit 1 → 100*(0.5*0.5 + 0.3*0.5 + 0.2*1) = 100*(0.25+0.15+0.20) = 60
        const snap = await buildRecruiterSnapshot(CTX, research(['AWS'], ['Kafka'], ['AWS']), ats(2, 4));
        expect(snap?.score).toBe(68);
        expect(snap?.missingKeywords).toEqual(['Kafka', 'gRPC']);
        expect(snap?.redFlags[0].flag).toBe('No streaming');
    });

    it('clamps to 100', async () => {
        mockRunAgent.mockResolvedValue({ data: { scoreDelta: 10, scoreRationale: 'x', missingKeywords: [], redFlags: [] } });
        const snap = await buildRecruiterSnapshot(CTX, research(['a'], [], []), ats(4, 4)); // baseline 100
        expect(snap?.score).toBe(100);
    });

    it('clamps to 0', async () => {
        // baseline 0 (no verified, ats 0/5), delta -10 → clamp to 0
        mockRunAgent.mockResolvedValue({ data: { scoreDelta: -10, scoreRationale: 'x', missingKeywords: [], redFlags: [] } });
        const snap = await buildRecruiterSnapshot(CTX, research([], ['g1'], ['AWS']), ats(0, 5));
        expect(snap?.score).toBe(0);
    });

    it('returns null when atsCheck is null (fail-open)', async () => {
        expect(await buildRecruiterSnapshot(CTX, research(['AWS'], ['Kafka'], ['AWS']), null)).toBeNull();
    });

    it('returns null when the agent throws (fail-open)', async () => {
        mockRunAgent.mockRejectedValue(new Error('bedrock down'));
        expect(await buildRecruiterSnapshot(CTX, research(['AWS'], ['Kafka'], ['AWS']), ats(2, 4))).toBeNull();
    });
});
