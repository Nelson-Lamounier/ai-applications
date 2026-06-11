/** @format */
jest.mock('./role-classifier.js', () => ({ classifyRole: jest.fn() }));
import type { Pool } from 'pg';
import { classifyRole } from './role-classifier.js';
import { resolveRoleFamilies } from './resolve-role-families.js';
import { RoleOntologyRepository } from '@bedrock/shared';

const FAM = { familyKey: 'technical-support', displayName: 'Technical Support', roleClass: 'customer_facing', canonicalResponsibilities: ['Triage queues'], vocabulary: ['SLA'], transferableSkills: ['empathy'], industryNotes: 'AWS≈SaaS' };

function repoStub(over: Partial<RoleOntologyRepository> = {}): RoleOntologyRepository {
    return {
        loadAliasMap: jest.fn().mockResolvedValue(new Map([['technical customer service associate', 'technical-support']])),
        loadFamilies: jest.fn().mockResolvedValue([FAM]),
        loadAllFamilyKeys: jest.fn().mockResolvedValue(['technical-support']),
        stageCandidate: jest.fn().mockResolvedValue(undefined),
        incrementPopularity: jest.fn().mockResolvedValue(undefined),
        insertCandidateFamily: jest.fn().mockResolvedValue(undefined),
        promote: jest.fn().mockResolvedValue(undefined),
        ...over,
    } as unknown as RoleOntologyRepository;
}

const pool = {} as Pool;

describe('resolveRoleFamilies', () => {
    it('alias hit → returns the matched family + bumps popularity (no classifier call)', async () => {
        const repo = repoStub();
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Technical Customer Service Associate', company: 'AWS', highlights: ['triaged IAM'] }], repo);
        expect(res[0].family?.familyKey).toBe('technical-support');
        expect(repo.incrementPopularity).toHaveBeenCalledWith('technical-support');
        expect(classifyRole).not.toHaveBeenCalled();
    });

    it('miss → classifier hit → stages alias + vocab candidates and returns the family', async () => {
        (classifyRole as jest.Mock).mockResolvedValue({ familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['queue'], suggestedTransferableSkills: ['triage'] });
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map()) });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Cust Svc Rep', company: 'AWS', highlights: ['tickets'] }], repo);
        expect(res[0].family?.familyKey).toBe('technical-support');
        expect(repo.stageCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidateType: 'alias', value: 'cust svc rep' }));
        expect(repo.stageCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidateType: 'vocabulary', value: 'queue' }));
    });

    it('miss + classifier null → returns null family (fail-open, no throw)', async () => {
        (classifyRole as jest.Mock).mockResolvedValue(null);
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map()) });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Astronaut', company: 'NASA', highlights: [] }], repo);
        expect(res[0].family).toBeNull();
    });

    it('calls promote with the quorum at the end', async () => {
        const repo = repoStub();
        await resolveRoleFamilies(pool, 'u-1', [{ title: 'Technical Customer Service Associate', company: 'AWS', highlights: [] }], repo);
        expect(repo.promote).toHaveBeenCalled();
    });

    it('alias substring match respects word boundaries (no over-match on short aliases)', async () => {
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map([['sre', 'technical-support']])) });
        // 'sre' must NOT match inside 'Deserves Recognition Lead'
        const over = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Deserves Recognition Lead', company: 'X', highlights: [] }], repo);
        expect(over[0].matchVia).not.toBe('alias');
        // but a word-bounded 'sre' in the title DOES match
        const hit = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Senior SRE Lead', company: 'X', highlights: [] }], repo);
        expect(hit[0].family?.familyKey).toBe('technical-support');
    });

    it('classifier → candidate family (in allKeys but NOT in grounded families) → stages a family vote, family null', async () => {
        // 'pending-family' is in loadAllFamilyKeys but NOT in loadFamilies (not grounded)
        (classifyRole as jest.Mock).mockResolvedValue({
            familyKey: 'pending-family', confidence: 0.8, companyType: 'saas',
            suggestedVocabulary: [], suggestedTransferableSkills: [],
        });
        const repo = repoStub({
            loadAliasMap: jest.fn().mockResolvedValue(new Map()),
            loadFamilies: jest.fn().mockResolvedValue([FAM]),
            loadAllFamilyKeys: jest.fn().mockResolvedValue(['technical-support', 'pending-family']),
        });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Growth Ops Lead', company: 'Acme', highlights: [] }], repo);
        expect(res[0].family).toBeNull();
        expect(res[0].matchVia).toBe('none');
        expect(res[0].companyType).toBe('saas');
        expect(repo.stageCandidate).toHaveBeenCalledWith(
            expect.objectContaining({ candidateType: 'family', value: 'pending-family', familyKey: 'pending-family' }),
        );
        expect(repo.insertCandidateFamily).not.toHaveBeenCalled();
    });

    it('classifier → newFamily (novel, not in ontology) → calls insertCandidateFamily + stages family vote', async () => {
        const novel = {
            familyKey: 'revenue-ops', displayName: 'Revenue Operations', roleClass: 'hybrid' as const,
            canonicalResponsibilities: ['Pipeline hygiene'], vocabulary: ['CRM'], transferableSkills: ['analytics'],
        };
        (classifyRole as jest.Mock).mockResolvedValue({
            familyKey: 'revenue-ops', confidence: 0.7, companyType: 'saas',
            suggestedVocabulary: [], suggestedTransferableSkills: [],
            newFamily: novel,
        });
        const repo = repoStub({
            loadAliasMap: jest.fn().mockResolvedValue(new Map()),
            // 'revenue-ops' is NOT in loadAllFamilyKeys → treated as novel
            loadAllFamilyKeys: jest.fn().mockResolvedValue(['technical-support']),
        });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Revenue Ops Manager', company: 'SaasCo', highlights: [] }], repo);
        expect(res[0].family).toBeNull();
        expect(res[0].companyType).toBe('saas');
        expect(repo.insertCandidateFamily).toHaveBeenCalledWith(novel);
        expect(repo.stageCandidate).toHaveBeenCalledWith(
            expect.objectContaining({ candidateType: 'family', value: 'revenue-ops', familyKey: 'revenue-ops' }),
        );
    });

    it('classifier → grounded family → threads companyType onto the resolved entry', async () => {
        (classifyRole as jest.Mock).mockResolvedValue({
            familyKey: 'technical-support', confidence: 0.95, companyType: 'infra_provider',
            suggestedVocabulary: [], suggestedTransferableSkills: [],
        });
        const repo = repoStub({ loadAliasMap: jest.fn().mockResolvedValue(new Map()) });
        const res = await resolveRoleFamilies(pool, 'u-1', [{ title: 'Support Engineer', company: 'AWS', highlights: [] }], repo);
        expect(res[0].family?.familyKey).toBe('technical-support');
        expect(res[0].matchVia).toBe('classifier');
        expect(res[0].companyType).toBe('infra_provider');
    });
});
