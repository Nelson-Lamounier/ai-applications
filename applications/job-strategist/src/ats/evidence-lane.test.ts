/** @format */
import { classifyLanes, attachSourceLanes, repoOfFile, type LaneIndex } from './evidence-lane.js';
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
    projectRepos: new Set<string>(),
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
    it('credits PROJECT when a cited repo belongs to a documented project', () => {
        const e = entry({ evidenceFiles: ['me/proj-repo/src/a.ts'] });
        const lanes = classifyLanes(e, index({ projectRepos: new Set(['me/proj-repo']) }));
        expect(lanes).toEqual(['project']);
    });

    it('credits REPO when a cited repo is standalone (not in any project)', () => {
        const e = entry({ evidenceFiles: ['me/standalone/src/a.ts'] });
        expect(classifyLanes(e, index({ projectRepos: new Set(['me/other']) }))).toEqual(['repo']);
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
            evidence: 'Also corroborated at AWS',
        });
        const lanes = classifyLanes(e, index({
            projectRepos: new Set(['me/proj-repo']),
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
        const out = attachSourceLanes(ledger, index({ projectRepos: new Set(['me/proj']) }));
        expect(out[0].sourceLanes).toEqual(['project']);
        expect(out[1].sourceLanes).toBeUndefined();
        expect(ledger[0].sourceLanes).toBeUndefined(); // input untouched
    });
});
