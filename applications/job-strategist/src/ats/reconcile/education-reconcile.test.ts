/** @format */
import { reconcileDegree, applyDegreeReconcile, isDegreeRequirement, isTechnicalField } from './education-reconcile.js';
import type { JobRequirement } from '@bedrock/shared';

const edu = (degree: string) => ({ degree, institution: 'Dublin Business School', period: '2022-2024' });
const softReq = (skill: string): JobRequirement => ({ skill, context: '' } as JobRequirement);

const PREFERRED = "Bachelor's degree in Computer Science, Computer Engineering, or relevant technical field";

describe('isDegreeRequirement (DEGREE_REQ_RE overmatch — F9)', () => {
    it('does NOT treat "a high degree of ownership" as a degree requirement', () => {
        expect(isDegreeRequirement('a high degree of ownership')).toBe(false);
    });

    it('does NOT treat "degree of automation" as a degree requirement', () => {
        expect(isDegreeRequirement('degree of automation')).toBe(false);
    });

    it('treats "Bachelor\'s degree in Computer Science" as a degree requirement', () => {
        expect(isDegreeRequirement("Bachelor's degree in Computer Science")).toBe(true);
    });

    it('treats "degree in Software Engineering" as a degree requirement', () => {
        expect(isDegreeRequirement('degree in Software Engineering')).toBe(true);
    });
});

describe('isTechnicalField (TECHNICAL_FIELD_RE overmatch — F9)', () => {
    it('does NOT credit Political Science as a relevant technical field', () => {
        expect(isTechnicalField('Political Science')).toBe(false);
    });

    it('does NOT credit Mechanical Engineering as a relevant technical field', () => {
        expect(isTechnicalField('Mechanical Engineering')).toBe(false);
    });

    it('does NOT credit Civil Engineering, Chemical Engineering, Business or English', () => {
        expect(isTechnicalField('Civil Engineering')).toBe(false);
        expect(isTechnicalField('Chemical Engineering')).toBe(false);
        expect(isTechnicalField('Business')).toBe(false);
        expect(isTechnicalField('English')).toBe(false);
    });

    it('credits Computer Science, Data Science, Software Engineering, Electronic Engineering, Computing', () => {
        expect(isTechnicalField('Computer Science')).toBe(true);
        expect(isTechnicalField('Data Science')).toBe(true);
        expect(isTechnicalField('Software Engineering')).toBe(true);
        expect(isTechnicalField('Electronic Engineering')).toBe(true);
        expect(isTechnicalField('Computing')).toBe(true);
    });
});

describe('reconcileDegree — real-world overmatch regression (F9)', () => {
    it('does NOT credit a Political Science degree against a Computer Science requirement (no false VERIFIED)', () => {
        const r = reconcileDegree({
            hardRequirements: [softReq("Bachelor's degree in Computer Science")],
            softRequirements: [],
            education: [edu('BA in Political Science')],
        });
        expect(r?.verified).toBeUndefined();
    });

    it('does NOT credit a Mechanical Engineering degree against a Computer Science requirement (no false VERIFIED)', () => {
        const r = reconcileDegree({
            hardRequirements: [softReq("Bachelor's degree in Computer Science")],
            softRequirements: [],
            education: [edu('BEng in Mechanical Engineering')],
        });
        expect(r?.verified).toBeUndefined();
    });
});

describe('reconcileDegree', () => {
    it('VERIFIES a relevant technical-field qualification when the JD allows equivalents (the Higher Diploma case)', () => {
        const r = reconcileDegree({
            hardRequirements: [],
            softRequirements: [softReq(PREFERRED)],
            education: [edu('Higher Diploma in Science in Computing (Web & Cloud Technologies)'), edu('BA (Honours) in Digital Marketing and Cloud Computing')],
        });
        expect(r?.verified).toBeDefined();
        expect(r?.verified?.sourceCitation).toMatch(/Higher Diploma in Science in Computing/);
        expect(r?.gap).toBeUndefined();
    });

    it('returns null when the JD asks for no degree', () => {
        expect(reconcileDegree({ hardRequirements: [], softRequirements: [softReq('Python scripting')], education: [edu('BSc Computing')] })).toBeNull();
    });

    it('PARTIAL when the JD names a specific degree (no equivalents) and the field differs in title', () => {
        const r = reconcileDegree({
            hardRequirements: [softReq("Bachelor's degree in Computer Science")],
            softRequirements: [],
            education: [edu('Higher Diploma in Computing')],
        });
        expect(r?.partial).toBeDefined();
        expect(r?.verified).toBeUndefined();
    });

    it('GAP (minor, equiv allowed) when there is no relevant education', () => {
        const r = reconcileDegree({ hardRequirements: [], softRequirements: [softReq(PREFERRED)], education: [edu('BA History')] });
        // History is non-technical → falls to the "degree but non-technical, equiv allowed" partial.
        expect(r?.partial ?? r?.gap).toBeDefined();
    });

    it('GAP when no education at all and the JD allows equivalents → minor soft gap', () => {
        const r = reconcileDegree({ hardRequirements: [], softRequirements: [softReq(PREFERRED)], education: [] });
        expect(r?.gap?.gapType).toBe('soft');
        expect(r?.gap?.impactSeverity).toBe('minor');
    });
});

describe('applyDegreeReconcile', () => {
    const empty = { verifiedMatches: [], partialMatches: [], gaps: [] };

    it('inserts the verified degree line, deduping any prior LLM degree entry', () => {
        const prior = {
            verifiedMatches: [],
            partialMatches: [],
            gaps: [{ skill: "Bachelor's degree in CS", gapType: 'soft' as const, impactSeverity: 'minor' as const, disqualifyingAssessment: 'no CS degree' }],
        };
        const { matching, result } = applyDegreeReconcile(prior, {
            hardRequirements: [], softRequirements: [softReq(PREFERRED)],
            education: [edu('Higher Diploma in Computing')],
        });
        expect(result?.verified).toBeDefined();
        expect(matching.gaps).toHaveLength(0);                 // the stale LLM degree gap is removed
        expect(matching.verifiedMatches).toHaveLength(1);      // replaced by the deterministic verified line
    });

    it('is a no-op when the JD asks for no degree', () => {
        const { matching, result } = applyDegreeReconcile(empty, { hardRequirements: [], softRequirements: [softReq('Kubernetes')], education: [] });
        expect(result).toBeNull();
        expect(matching).toBe(empty);
    });
});
