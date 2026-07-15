/** @format */
import { describe, it, expect } from '@jest/globals';
import { bulletsOf } from '../../agents/writer/experience-ats-flow.js';
import { checkVerbAlignment } from '../../agents/writer/verb-alignment.js';
import { scoreExperienceCoverage } from '../../ats/gate/experience-coverage.js';
import {
    runExperienceGraders,
    provenanceGrader,
    noFabricationGrader,
    atsCoverageGrader,
    voiceGrader,
    reorderGrader,
    verbAlignmentGrader,
} from './experience-graders.js';
import {
    GOLDEN_NETWORKING, ADVERSARIAL_CROSS_ROLE, ADVERSARIAL_FABRICATION, ADVERSARIAL_REORDER,
    LINUX_ANCHORED_LIVE, TERM_TOLERANT_AWS_DB, NO_EVIDENCE_MISSING,
    ECHO_CLEANUP_VALID, ECHO_CLEANUP_INVALID,
    MISSION_CRITICAL_DB, CODE_SCRIPTING, RAPID_LEARNING,
    VERB_UPGRADE, VERB_LEGITIMISED,
} from './fixtures.js';

describe('experience graders', () => {
    it('the golden networking output passes every grader', () => {
        const r = runExperienceGraders(GOLDEN_NETWORKING);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('a cross-role citation fails ONLY provenanceGrader', () => {
        const r = runExperienceGraders(ADVERSARIAL_CROSS_ROLE);
        expect(provenanceGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(false);
        expect(noFabricationGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_CROSS_ROLE).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['provenance']);
        expect(r.pass).toBe(false);
    });

    it('an invented "47%" fails ONLY noFabricationGrader', () => {
        const r = runExperienceGraders(ADVERSARIAL_FABRICATION);
        expect(provenanceGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(noFabricationGrader(ADVERSARIAL_FABRICATION).pass).toBe(false);
        expect(atsCoverageGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_FABRICATION).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['noFabrication']);
        expect(r.pass).toBe(false);
    });

    it('reorderGrader fails when a non-covering bullet leads a covering role', () => {
        const r = runExperienceGraders(ADVERSARIAL_REORDER);
        expect(provenanceGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(noFabricationGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(atsCoverageGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(voiceGrader(ADVERSARIAL_REORDER).pass).toBe(true);
        expect(reorderGrader(ADVERSARIAL_REORDER).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['reorder']);
        expect(r.pass).toBe(false);
    });

    it('atsCoverage passes vacuously when a fixture has no ATS targets', () => {
        const r = atsCoverageGrader({ ...GOLDEN_NETWORKING, atsTargets: [] });
        expect(r.pass).toBe(true);
    });

    it('atsCoverage fails when the output misses too many targets', () => {
        const r = atsCoverageGrader({
            ...GOLDEN_NETWORKING,
            output: {
                ...GOLDEN_NETWORKING.output,
                roles: [
                    { ...GOLDEN_NETWORKING.output.roles[0], highlights: [] },
                    GOLDEN_NETWORKING.output.roles[1],
                ],
            },
        });
        expect(r.pass).toBe(false);
    });

    it('reorderGrader passes vacuously when no bullet covers any target', () => {
        const r = reorderGrader({ ...GOLDEN_NETWORKING, atsTargets: [] });
        expect(r.pass).toBe(true);
    });
});

describe('spec case 1 -- anchored Linux target (verbatim from the live run)', () => {
    it('is covered via anchor citation, provenance-clean and ATS-covered', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(LINUX_ANCHORED_LIVE.output), LINUX_ANCHORED_LIVE.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 1, missing: [] });
        // The verbatim live-run bullet text predates the voice guard's 32-word
        // budget (37 words) -- provenance and ATS coverage are what this spec
        // case exercises; voiceGrader failing on this specific text is a
        // faithful, expected artefact of reusing the real diagnostic string,
        // not a regression.
        expect(provenanceGrader(LINUX_ANCHORED_LIVE).pass).toBe(true);
        expect(atsCoverageGrader(LINUX_ANCHORED_LIVE).pass).toBe(true);
    });
});

describe('spec case 2 -- term-tolerant target (zero anchors, discriminating terms alone)', () => {
    it('is covered via term match though the exact phrase never appears', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(TERM_TOLERANT_AWS_DB.output), TERM_TOLERANT_AWS_DB.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 1, missing: [] });
        const r = runExperienceGraders(TERM_TOLERANT_AWS_DB);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('spec case 3 -- no-evidence target stays missing', () => {
    it('a target with zero anchors and zero matching terms is never vacuously covered', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(NO_EVIDENCE_MISSING.output), NO_EVIDENCE_MISSING.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 0, missing: ['Distributed systems design'] });
        expect(atsCoverageGrader(NO_EVIDENCE_MISSING).pass).toBe(false);
    });
});

describe('echo-cleanup (review finding B): jd-echo routed re-write output', () => {
    it('accepts a rephrased, provenance-clean output citing only the flagged bullet\'s own career lines', () => {
        const r = runExperienceGraders(ECHO_CLEANUP_VALID);
        expect(provenanceGrader(ECHO_CLEANUP_VALID).pass).toBe(true);
        expect(r.pass).toBe(true);
    });

    it('rejects a rephrase that cites a career line it did not have (fabricated source id)', () => {
        const violations = provenanceGrader(ECHO_CLEANUP_INVALID);
        expect(violations.pass).toBe(false);
        const r = runExperienceGraders(ECHO_CLEANUP_INVALID);
        expect(r.pass).toBe(false);
    });
});

describe('term-rule v2 promotions (Task 3): experienceTermMatch LIVE/REGRESSION cases at grader level', () => {
    it('MISSION_CRITICAL_DB is covered -- emphasis tokens strip out, leaving {production, database}', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(MISSION_CRITICAL_DB.output), MISSION_CRITICAL_DB.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 1, missing: [] });
        const r = runExperienceGraders(MISSION_CRITICAL_DB);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('CODE_SCRIPTING is covered -- a named language plus lightStem-bridged read/script terms', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(CODE_SCRIPTING.output), CODE_SCRIPTING.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 1, missing: [] });
        const r = runExperienceGraders(CODE_SCRIPTING);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('RAPID_LEARNING stays missing -- an honest synonym/evidence gap, never vacuously covered', () => {
        const coverage = scoreExperienceCoverage(bulletsOf(RAPID_LEARNING.output), RAPID_LEARNING.atsTargets);
        expect(coverage).toEqual({ targets: 1, covered: 0, missing: ['rapid technical learning'] });
        expect(atsCoverageGrader(RAPID_LEARNING).pass).toBe(false);
    });
});

describe('verb-alignment eval cases (Task 2 guard promoted to grader level)', () => {
    it('VERB_UPGRADE: an assisted-only citation trips ONLY verbAlignmentGrader', () => {
        // Exactly ONE finding, with the zero-support ceiling of 1 -- the cited
        // line's only lexicon verb is "Assisted" (tier 1); no other word in it
        // resolves against VERB_TIERS.
        expect(checkVerbAlignment(VERB_UPGRADE.output, VERB_UPGRADE.careerLines))
            .toEqual([{ role: 0, bullet: 0, verb: 'own', tier: 3, ceiling: 1 }]);
        const r = runExperienceGraders(VERB_UPGRADE);
        expect(provenanceGrader(VERB_UPGRADE).pass).toBe(true);
        expect(noFabricationGrader(VERB_UPGRADE).pass).toBe(true);
        expect(atsCoverageGrader(VERB_UPGRADE).pass).toBe(true);
        expect(voiceGrader(VERB_UPGRADE).pass).toBe(true);
        expect(reorderGrader(VERB_UPGRADE).pass).toBe(true);
        expect(verbAlignmentGrader(VERB_UPGRADE).pass).toBe(false);
        expect(r.results.filter((x) => !x.pass).map((x) => x.grader)).toEqual(['verbAlignment']);
        expect(r.pass).toBe(false);
    });

    it('VERB_LEGITIMISED: the live two-citation case is clean end to end', () => {
        const r = runExperienceGraders(VERB_LEGITIMISED);
        expect(verbAlignmentGrader(VERB_LEGITIMISED).pass).toBe(true);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });
});
