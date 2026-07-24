/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import type { ExperienceAtsTarget } from '../experience-ats-targets.js';
import { selectProjectsAtsTargets } from '../projects-ats-targets.js';

function target(skill: string): ExperienceAtsTarget {
    return { skill, source: 'disqualifying', verdict: 'verified', requirement: skill, anchors: [] };
}

function entry(tool: string, sourceLanes?: SkillEvidenceEntry['sourceLanes']): SkillEvidenceEntry {
    return {
        tool, status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '',
        ...(sourceLanes !== undefined ? { sourceLanes } : {}),
    };
}

describe('selectProjectsAtsTargets', () => {
    it('excludes career-only targets and keeps repo/project-evidenced ones', () => {
        const targets = [target('SQL'), target('Customer-facing support'), target('Communication')];
        const ledger = [
            entry('SQL', ['repo']),
            entry('Customer-facing support', ['career']),
            entry('Communication', ['career']),
        ];
        const split = selectProjectsAtsTargets(targets, ledger);
        expect(split.targets.map((t) => t.skill)).toEqual(['SQL']);
        expect(split.excluded).toEqual(['Customer-facing support', 'Communication']);
    });

    it('keeps a target evidenced by both career and project lanes', () => {
        const split = selectProjectsAtsTargets(
            [target('JavaScript')],
            [entry('JavaScript', ['career', 'project'])],
        );
        expect(split.targets.map((t) => t.skill)).toEqual(['JavaScript']);
        expect(split.excluded).toEqual([]);
    });

    it('fails open for ledger rows without sourceLanes (legacy) and empty lane lists', () => {
        const split = selectProjectsAtsTargets(
            [target('HTML'), target('CSS')],
            [entry('HTML'), entry('CSS', [])],
        );
        expect(split.targets.map((t) => t.skill)).toEqual(['HTML', 'CSS']);
        expect(split.excluded).toEqual([]);
    });

    it('fails open for a target with no ledger row at all', () => {
        const split = selectProjectsAtsTargets([target('Terraform')], []);
        expect(split.targets.map((t) => t.skill)).toEqual(['Terraform']);
        expect(split.excluded).toEqual([]);
    });

    it('matches ledger rows case-insensitively', () => {
        const split = selectProjectsAtsTargets(
            [target('sql')],
            [entry('SQL', ['career'])],
        );
        expect(split.targets).toEqual([]);
        expect(split.excluded).toEqual(['sql']);
    });
});
