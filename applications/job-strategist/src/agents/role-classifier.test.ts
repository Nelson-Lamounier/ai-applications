/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { classifyRole } from './role-classifier.js';

const KNOWN = ['technical-support', 'sre'];
const mockRun = runAgent as jest.Mock;

describe('classifyRole', () => {
    it('returns the classified family + suggestions when the model picks a known family', async () => {
        mockRun.mockResolvedValue({ data: { familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['SLA'], suggestedTransferableSkills: ['empathy'] } });
        const r = await classifyRole({ title: 'Support Rep', company: 'Acme', highlights: ['handled tickets'] }, KNOWN);
        expect(r).toEqual({ familyKey: 'technical-support', confidence: 0.9, suggestedVocabulary: ['SLA'], suggestedTransferableSkills: ['empathy'] });
    });

    it('returns null when the model returns an unknown family (caller falls back)', async () => {
        mockRun.mockResolvedValue({ data: { familyKey: 'astronaut', confidence: 0.5, suggestedVocabulary: [], suggestedTransferableSkills: [] } });
        expect(await classifyRole({ title: 'Astronaut', company: 'NASA', highlights: [] }, KNOWN)).toBeNull();
    });

    it('returns null on agent error (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        expect(await classifyRole({ title: 'X', company: 'Y', highlights: [] }, KNOWN)).toBeNull();
    });
});
