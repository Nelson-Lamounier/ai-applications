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
        stageCandidate: jest.fn().mockResolvedValue(undefined),
        incrementPopularity: jest.fn().mockResolvedValue(undefined),
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
});
