/** @format */
import { describe, it, expect } from '@jest/globals';
import { computeUserDiagnostic, WEIGHTS, KB_SCORE_THRESHOLD } from './computeUserDiagnostic.js';
import type {
    UserProfileRollup,
    MirrorJson,
    RevealJson,
    DirectionJson,
    ReconciliationJson,
    DiagnosticInputs,
} from '@bedrock/shared';

const baseRollup = {
    version: 1,
    languages: [
        { language: 'TypeScript', repoCount: 5, commitVolumeProxy: 400, sharePct: 60 },
        { language: 'Python',     repoCount: 2, commitVolumeProxy: 80,  sharePct: 20 },
        { language: 'Go',         repoCount: 1, commitVolumeProxy: 20,  sharePct: 8  },
    ],
    domains: { counts: { infra: 4, web: 2 }, dominant: 'infra' },
    complexity: { simple: 1, moderate: 3, complex: 1 },
    roles: { creator: 4, maintainer: 1, contributor: 0 },
    techStackTop: [{ tech: 'AWS', repoCount: 4 }],
    activityArc: [{ repoFullName: 'o/a', lastActiveAt: '2024-01-01T00:00:00Z', primaryLanguage: 'TypeScript', domain: 'infra' }],
    totals: { projectRepoCount: 8, totalCommitVolumeProxy: 700, earliestActivity: '2024-01-01T00:00:00Z', latestActivity: '2026-01-01T00:00:00Z', activeYearsApprox: 2 },
    classificationCounts: { project: 8, hiddenCount: 0 },
    methodology: { version: 1, commitVolume: 'proxy', domainMix: 'repo-count share', scope: 's', confidence: 'c' },
} as unknown as UserProfileRollup;

const fullInputs: DiagnosticInputs = {
    kbStats:     { projectRepoCount: 8, reposWithHighKbScore: 6, avgRetrievalScore: 0.85 },
    resumePresent: true,
    resumeEntryCounts: { skills: 3, experience: 4, projects: 2 },
};

const mirror:  MirrorJson  = { paragraph: 'You build infrastructure-heavy systems with TypeScript at the core.' };
const reveal:  RevealJson  = { reveals: [{ insight: 'systems thinker', evidence: 'k8s pipelines, AWS depth' }] };
const direction: DirectionJson = {
    archetypes: [
        { archetype: 'platform', fit: 'strong',   rationale: 'infra-dominant domain mix' },
        { archetype: 'devops',   fit: 'strong',   rationale: 'IaC tech stack' },
        { archetype: 'backend',  fit: 'moderate', rationale: 'TS language share' },
    ],
    seniority: [{ area: 'infrastructure', level: 'senior', evidence: 'complexity skews complex' }],
    whatToDeepen: ['Add incident-response evidence.'],
};
const reconciliation: ReconciliationJson = {
    unsupportedClaims: [
        { claim: 'Led a 12-person ML platform team', resumeRef: 'Acme', whyUnsupported: 'no ml domain' },
    ],
    undersold: [
        { evidence: 'Strong TS output', rollupDimension: 'language share', suggestion: 'add a TS bullet' },
    ],
};

describe('computeUserDiagnostic', () => {
    it('exports equal weights of 20 each, summing to 100', () => {
        expect(WEIGHTS).toEqual({ profileDepth: 20, ragDepth: 20, directionConfidence: 20, reconciliationAlignment: 20, resumeCoverage: 20 });
        expect(Object.values(WEIGHTS).reduce((a,b)=>a+b,0)).toBe(100);
    });

    it('exports KB_SCORE_THRESHOLD = 0.6', () => {
        expect(KB_SCORE_THRESHOLD).toBe(0.6);
    });

    it('produces a high overall + populated components on a complete profile', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: fullInputs,
        });
        expect(r.overall).toBeGreaterThanOrEqual(80);
        expect(r.components.profileDepth.score).toBeGreaterThanOrEqual(80);
        expect(r.components.ragDepth.score).toBeGreaterThanOrEqual(70);
        expect(r.components.directionConfidence.score).toBeGreaterThanOrEqual(80);
        expect(r.components.reconciliationAlignment.score).toBeGreaterThanOrEqual(80);
        expect(r.components.resumeCoverage.score).toBe(100);
        expect(r.methodology).toMatchObject({ version: 1, weights: { profileDepth: 20 } });
    });

    it('profileDepth: low rollup → low score with concrete blockers', () => {
        const tinyRollup = { ...baseRollup,
            languages: [{ language: 'TypeScript', repoCount: 1, commitVolumeProxy: 5, sharePct: 2 }],
            totals: { ...baseRollup.totals, projectRepoCount: 1 },
        } as unknown as UserProfileRollup;
        const r = computeUserDiagnostic({
            rollup: tinyRollup, mirror: null, reveal: null, direction: null, reconciliation: null,
            diagnosticInputs: { ...fullInputs, kbStats: { projectRepoCount: 1, reposWithHighKbScore: 0, avgRetrievalScore: null } },
        });
        expect(r.components.profileDepth.score).toBeLessThan(40);
        expect(r.components.profileDepth.blockers.some(b => /language|share|project repos|Mirror/i.test(b))).toBe(true);
    });

    it('ragDepth: zero project repos → score 0 with concrete blockers', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: { ...fullInputs, kbStats: { projectRepoCount: 0, reposWithHighKbScore: 0, avgRetrievalScore: null } },
        });
        expect(r.components.ragDepth.score).toBe(0);
        expect(r.components.ragDepth.blockers.length).toBeGreaterThanOrEqual(1);
    });

    it('directionConfidence: no direction → score 0 with concrete blockers', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction: null, reconciliation,
            diagnosticInputs: fullInputs,
        });
        expect(r.components.directionConfidence.score).toBe(0);
        expect(r.components.directionConfidence.blockers.length).toBeGreaterThanOrEqual(1);
    });

    it('reconciliationAlignment: résumé absent → 0 with "Résumé not imported"', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: { ...fullInputs, resumePresent: false, resumeEntryCounts: { skills: 0, experience: 0, projects: 0 } },
        });
        expect(r.components.reconciliationAlignment.score).toBe(0);
        expect(r.components.reconciliationAlignment.blockers).toContain('Résumé not imported');
    });

    it('reconciliationAlignment: many unsupported claims → low score (penalty applied)', () => {
        const many: ReconciliationJson = { unsupportedClaims: Array.from({length: 8}, (_,i) => ({ claim: `claim ${i+1} text`, resumeRef: 'Acme', whyUnsupported: 'why text here' })), undersold: [] };
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation: many,
            diagnosticInputs: fullInputs,
        });
        expect(r.components.reconciliationAlignment.score).toBeLessThanOrEqual(20);
    });

    it('resumeCoverage: missing experience + projects → reduced score with bucket blockers', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: { ...fullInputs, resumeEntryCounts: { skills: 1, experience: 0, projects: 0 } },
        });
        expect(r.components.resumeCoverage.score).toBeLessThan(50);
        expect(r.components.resumeCoverage.blockers.length).toBeGreaterThan(0);
    });

    it('overall = round(sum(WEIGHTS[k] * components[k].score / 100))', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: fullInputs,
        });
        const sum = Object.entries(WEIGHTS).reduce((acc, [k, w]) => acc + w * (r.components as never as Record<string,{score:number}>)[k].score / 100, 0);
        expect(r.overall).toBe(Math.round(sum));
    });

    it('methodology v1 + equal weights + notes string', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: fullInputs,
        });
        expect(r.methodology.version).toBe(1);
        expect(r.methodology.weights).toEqual(WEIGHTS);
        expect(typeof r.methodology.notes).toBe('string');
        expect(r.methodology.notes.length).toBeGreaterThan(10);
    });

    it('all sub-scores are integers in [0, 100]; overall is an integer in [0, 100]', () => {
        const r = computeUserDiagnostic({
            rollup: baseRollup, mirror, reveal, direction, reconciliation,
            diagnosticInputs: fullInputs,
        });
        for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
            const s = r.components[k].score;
            expect(Number.isInteger(s)).toBe(true);
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(100);
        }
        expect(Number.isInteger(r.overall)).toBe(true);
        expect(r.overall).toBeGreaterThanOrEqual(0);
        expect(r.overall).toBeLessThanOrEqual(100);
    });
});
