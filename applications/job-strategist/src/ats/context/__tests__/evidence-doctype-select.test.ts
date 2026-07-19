/** @format */
import { deriveEvidenceDocTypes } from '../evidence-doctype-select.js';
import type { JdSignal } from '@bedrock/shared';

type Jd = Parameters<typeof deriveEvidenceDocTypes>[0];

const EMPTY_DIMENSION_MIX: JdSignal['dimensionMix'] = {
    customerFacing: 0,
    technical: 100,
    aiMl: 0,
    supportOps: 0,
    monitoring: 0,
};

function jd(overrides: Partial<Jd> = {}): Jd {
    return {
        dimensionMix: EMPTY_DIMENSION_MIX,
        concepts: [],
        responsibilities: [],
        retrievalKeywords: [],
        ...overrides,
    };
}

describe('deriveEvidenceDocTypes', () => {
    it('returns operations docTypes when supportOps + monitoring >= 25', () => {
        const result = deriveEvidenceDocTypes(jd({
            dimensionMix: { ...EMPTY_DIMENSION_MIX, supportOps: 15, monitoring: 12 },
        }));
        expect(result.angle).toBe('operations');
        expect(result.docTypes).toEqual(['runbook', 'troubleshooting']);
    });

    it('does not trigger operations when supportOps + monitoring < 25 and no keywords', () => {
        const result = deriveEvidenceDocTypes(jd({
            dimensionMix: { ...EMPTY_DIMENSION_MIX, supportOps: 10, monitoring: 10 },
        }));
        expect(result).toEqual({ docTypes: [], angle: null });
    });

    it('returns architecture docTypes when concepts mention system design', () => {
        const result = deriveEvidenceDocTypes(jd({
            concepts: ['system design', 'microservices'],
        }));
        expect(result.angle).toBe('architecture');
        expect(result.docTypes).toEqual(['adr']);
    });

    it('returns [] / null for a plain frontend JD with no signal', () => {
        const result = deriveEvidenceDocTypes(jd({
            concepts: ['react', 'css', 'accessibility'],
            responsibilities: ['build UI components', 'write unit tests'],
        }));
        expect(result).toEqual({ docTypes: [], angle: null });
    });

    it('returns the union with angle "both" when both signals fire', () => {
        const result = deriveEvidenceDocTypes(jd({
            dimensionMix: { ...EMPTY_DIMENSION_MIX, supportOps: 20, monitoring: 10 },
            concepts: ['distributed systems', 'architecture'],
        }));
        expect(result.angle).toBe('both');
        expect(result.docTypes).toEqual(['adr', 'runbook', 'troubleshooting']);
    });

    it('detects operations via a keyword alone when dimensionMix is zero', () => {
        const result = deriveEvidenceDocTypes(jd({
            concepts: ['incident response'],
        }));
        expect(result.angle).toBe('operations');
        expect(result.docTypes).toEqual(['runbook', 'troubleshooting']);
    });

    it('detects architecture via "architect" keyword in responsibilities', () => {
        const result = deriveEvidenceDocTypes(jd({
            responsibilities: ['Act as the technical architect for the platform'],
        }));
        expect(result.angle).toBe('architecture');
        expect(result.docTypes).toEqual(['adr']);
    });

    it('detects operations via "on-call" and "on call" spelling variants', () => {
        expect(deriveEvidenceDocTypes(jd({ concepts: ['on-call rotation'] })).angle).toBe('operations');
        expect(deriveEvidenceDocTypes(jd({ concepts: ['on call rotation'] })).angle).toBe('operations');
    });

    it('detects operations via "postmortem" and "post-mortem" spelling variants', () => {
        expect(deriveEvidenceDocTypes(jd({ concepts: ['postmortem culture'] })).angle).toBe('operations');
        expect(deriveEvidenceDocTypes(jd({ concepts: ['post-mortem culture'] })).angle).toBe('operations');
    });

    it('detects architecture via "trade-off" and "tradeoff" spelling variants', () => {
        expect(deriveEvidenceDocTypes(jd({ concepts: ['trade-off analysis'] })).angle).toBe('architecture');
        expect(deriveEvidenceDocTypes(jd({ concepts: ['tradeoff analysis'] })).angle).toBe('architecture');
    });

    it('scans retrievalKeywords too, not just concepts/responsibilities', () => {
        const result = deriveEvidenceDocTypes(jd({ retrievalKeywords: ['SLA', 'SLO'] }));
        expect(result.angle).toBe('operations');
    });

    it('is case-insensitive', () => {
        const result = deriveEvidenceDocTypes(jd({ concepts: ['SYSTEM DESIGN'] }));
        expect(result.angle).toBe('architecture');
    });

    it('dedupes and orders docTypes stably as [adr, runbook, troubleshooting]', () => {
        const result = deriveEvidenceDocTypes(jd({
            dimensionMix: { ...EMPTY_DIMENSION_MIX, supportOps: 30, monitoring: 30 },
            concepts: ['architecture', 'reliability', 'sre'],
        }));
        expect(result.docTypes).toEqual(['adr', 'runbook', 'troubleshooting']);
    });
});
