/** @format */
import {classifyLanes, attachSourceLanes, repoOfFile, type LaneIndex, expandLaneNeedles, mergeRepoLane } from './evidence-lane.js';
import type { SkillEvidenceEntry } from '@bedrock/shared';

const entry = (over: Partial<SkillEvidenceEntry>): SkillEvidenceEntry => ({
    tool: 'x',
    status: 'verified',
    evidenceFiles: [],
    evidence: '',
    transferableBridge: '',
    ...over,
});

const index = (over: Partial<LaneIndex> = {}): LaneIndex => ({
    projectNames: [],
    careerTerms: [],
    ...over,
});

describe('repoOfFile', () => {
    it('extracts owner/repo', () => {
        expect(repoOfFile('Nelson-Lamounier/cdk-monitoring/.checkov/x.py')).toBe('Nelson-Lamounier/cdk-monitoring');
    });
    it('returns null when not repo-scoped', () => {
        expect(repoOfFile('file.ts')).toBeNull();
        expect(repoOfFile('owner/repo')).toBeNull();
    });
});

describe('classifyLanes', () => {
    it('credits REPO for any file-backed evidence (code leads, regardless of project linkage)', () => {
        const e = entry({ evidenceFiles: ['me/proj-repo/src/a.ts'] });
        expect(classifyLanes(e, index({ projectNames: ['Some Project'] }))).toEqual(['repo']);
    });

    it('credits REPO for a standalone repo file just the same', () => {
        const e = entry({ evidenceFiles: ['me/standalone/src/a.ts'] });
        expect(classifyLanes(e, index())).toEqual(['repo']);
    });

    it('credits REPO + PROJECT when code is also described in a documented case study', () => {
        const e = entry({ evidenceFiles: ['me/proj-repo/src/a.ts'], evidence: 'Built in the Tucaken Quota project' });
        expect(classifyLanes(e, index({ projectNames: ['Tucaken Quota'] }))).toEqual(['repo', 'project']);
    });

    it('credits CAREER when file-less evidence names a career company/title', () => {
        const e = entry({ status: 'transferable', evidence: 'Demonstrated at AWS as a Technical Customer Service Associate' });
        const lanes = classifyLanes(e, index({ careerTerms: ['AWS', 'Technical Customer Service Associate'] }));
        expect(lanes).toEqual(['career']);
    });

    it('credits PROJECT from prose when the evidence names a documented project', () => {
        const e = entry({ status: 'transferable', evidence: 'Root-cause analysis demonstrated in the Tucaken Quota project' });
        expect(classifyLanes(e, index({ projectNames: ['Tucaken Quota'] }))).toEqual(['project']);
    });

    it('returns multiple lanes in stable order (repo, project, career)', () => {
        const e = entry({
            evidenceFiles: ['me/proj-repo/a.ts', 'me/standalone/b.ts'],
            evidence: 'Built in the Tucaken Quota project, also corroborated at AWS',
        });
        const lanes = classifyLanes(e, index({
            projectNames: ['Tucaken Quota'],
            careerTerms: ['AWS'],
        }));
        expect(lanes).toEqual(['repo', 'project', 'career']);
    });

    it('returns [] for an honest gap with no files and no prose match', () => {
        expect(classifyLanes(entry({ status: 'gap' }), index())).toEqual([]);
    });

    it('ignores empty/whitespace career terms (no false career credit)', () => {
        const e = entry({ evidence: 'some prose' });
        expect(classifyLanes(e, index({ careerTerms: ['', '  '] }))).toEqual([]);
    });
});

describe('attachSourceLanes', () => {
    it('adds sourceLanes only to classifiable entries; never mutates input', () => {
        const ledger: SkillEvidenceEntry[] = [
            entry({ tool: 'a', evidenceFiles: ['me/proj/a.ts'] }),
            entry({ tool: 'b', status: 'gap' }),
        ];
        const out = attachSourceLanes(ledger, index());
        expect(out[0].sourceLanes).toEqual(['repo']);
        expect(out[1].sourceLanes).toBeUndefined();
        expect(ledger[0].sourceLanes).toBeUndefined(); // input untouched
    });
});

describe('expandLaneNeedles + shortened-name matching', () => {
    it('matches prose citing the short project name against the full catalogued name', () => {
        const entry: SkillEvidenceEntry = {
            tool: 'State management', status: 'verified', evidenceFiles: [],
            evidence: 'AI Applications Platform: RdsSyncStateRepository tracks sync status per user/repo.',
            transferableBridge: '',
        } as SkillEvidenceEntry;
        const lanes = classifyLanes(entry, {
            projectNames: ['AI Applications Platform with Infrastructure-as-Code'],
            careerTerms: [],
        });
        expect(lanes).toContain('project');
    });

    it('expands "Company (ABBR)" into base + long abbreviation, never short ones', () => {
        const needles = expandLaneNeedles(['Amazon Web Services (AWS)', 'Meta via Accenture (ACNT)']);
        expect(needles).toContain('Amazon Web Services');
        expect(needles).not.toContain('AWS');       // 3 chars — would over-attribute
        expect(needles).toContain('ACNT');
    });

    it('classifies resume-data citations as career content', () => {
        const entry: SkillEvidenceEntry = {
            tool: 'Customer relationship management', status: 'verified',
            evidenceFiles: ['Nelson-Lamounier/frontend-portfolio/apps/site/src/lib/resumes/resume-data.ts'],
            evidence: 'Career history shows direct customer escalation ownership.',
            transferableBridge: '',
        } as SkillEvidenceEntry;
        const lanes = classifyLanes(entry, { projectNames: [], careerTerms: [] });
        expect(lanes).toEqual(expect.arrayContaining(['repo', 'career']));
    });
});

describe('mergeRepoLane', () => {
    it('adds repo for entries that gained files after lane classification', () => {
        const [out] = mergeRepoLane([{
            tool: 'OpenAI API', status: 'transferable',
            evidenceFiles: ['Nelson-Lamounier/ai-applications/src/bedrock/agent.ts'],
            evidence: 'x', transferableBridge: 'interchangeable alternative (aws bedrock)',
            sourceLanes: ['career'],
        } as SkillEvidenceEntry]);
        expect(out.sourceLanes).toEqual(['repo', 'career']);
    });

    it('never touches gap entries or removes lanes', () => {
        const [gap] = mergeRepoLane([{
            tool: 'GCP', status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: '',
        } as SkillEvidenceEntry]);
        expect(gap.sourceLanes).toBeUndefined();
    });
});
