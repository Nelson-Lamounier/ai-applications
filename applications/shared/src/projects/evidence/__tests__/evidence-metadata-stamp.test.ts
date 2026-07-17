/** @format */
import { buildEvidenceStamp } from '../evidence-metadata-stamp.js';
import type { RepoSignals } from '../evidence-metadata-stamp.js';

const base: RepoSignals = {
    repoFullName: 'o/r', classification: 'project', qualityScore: 1,
    ownerIsUser: true, userAuthored: true, techStack: ['aws_eks', 'aws_cdk'], domain: 'cdk-infra',
};

describe('buildEvidenceStamp', () => {
    it("the user's own authored repo → authored, not inferred", () => {
        const s = buildEvidenceStamp(base);
        expect(s).toMatchObject({ is_fork: false, authored: true, role_inferred: false, owner_is_user: true, repo_confidence: 1 });
        expect(s.repo_tech_stack).toEqual(['aws_cdk', 'aws_eks']); // sorted
    });

    it('third-party referenced repo (not owner, no user commits) → role_inferred (the sindresorhus/is case)', () => {
        const s = buildEvidenceStamp({ ...base, repoFullName: 'sindresorhus/is', ownerIsUser: false, userAuthored: false, qualityScore: 0.55 });
        expect(s.authored).toBe(false);
        expect(s.role_inferred).toBe(true);
        expect(s.owner_is_user).toBe(false);
    });

    it('contributed-to-but-not-owner (user committed via PR) → authored', () => {
        const s = buildEvidenceStamp({ ...base, ownerIsUser: false, userAuthored: true });
        expect(s.authored).toBe(true);
        expect(s.role_inferred).toBe(false);
    });

    it('owns the repo but no commit data → still authored (ownership)', () => {
        const s = buildEvidenceStamp({ ...base, userAuthored: false, ownerIsUser: true });
        expect(s.authored).toBe(true);
    });

    it('a fork is NEVER authored, even if owned/committed', () => {
        const s = buildEvidenceStamp({ ...base, classification: 'fork', ownerIsUser: true, userAuthored: true });
        expect(s.is_fork).toBe(true);
        expect(s.authored).toBe(false);
        expect(s.role_inferred).toBe(true);
    });

    it('null classification / quality → safe defaults', () => {
        const s = buildEvidenceStamp({ ...base, classification: null, qualityScore: null });
        expect(s.repo_classification).toBe('unknown');
        expect(s.repo_confidence).toBe(0);
    });
});
