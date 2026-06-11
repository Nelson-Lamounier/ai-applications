/** @format */
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult } from '@bedrock/shared';
import { computeBaselineScore } from './recruiter-snapshot.js';

function ats(present: number, total: number): AtsCheckResult {
    const cov = Array.from({ length: total }, (_, i) => ({ term: `k${i}`, present: i < present, grounded: false }));
    return {
        machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
        parseBreakers: [], jdKeywordCoverage: cov, status: 'passed', passed: true, issues: [],
    };
}
function research(verified: string[], gaps: string[], hardReqs: string[]): Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'> {
    return {
        verifiedMatches: verified.map((skill) => ({ skill, sourceCitation: '', depth: 'deep', recency: '' })),
        gaps:            gaps.map((skill) => ({ skill, gapType: 'missing', impactSeverity: 'high', disqualifyingAssessment: '' })),
        hardRequirements: hardReqs.map((skill) => ({ skill, context: '' })),
    } as unknown as Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>;
}

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
});
