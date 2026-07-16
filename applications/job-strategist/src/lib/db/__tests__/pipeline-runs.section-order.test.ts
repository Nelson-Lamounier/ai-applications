/**
 * @format
 * persistTailoredResume -- canonical sectionOrder stamped at the persist
 * choke point. Every persist path (main persist, ATS surface-keywords
 * re-persist, semantic-cache replay, free tier) flows through this function,
 * so an LLM-echoed sectionOrder must never survive into the resumes row.
 */
import { CANONICAL_SECTION_ORDER } from '../../resume/section-order.js';

const mockQuery = jest.fn(async () => ({ rowCount: 1 }));

jest.mock('../rls.js', () => ({
    withUserRls: async (_pool: unknown, _userId: string, fn: (client: { query: typeof mockQuery }) => Promise<void>) =>
        fn({ query: mockQuery }),
}));

import { persistTailoredResume } from '../pipeline-runs.js';

const baseResume = {
    profile: { name: 'Nelson', title: 'Engineer', email: 'n@example.com', location: 'Dublin' },
    projects: [{ name: 'Tucaken', description: 'A resume-tailoring platform.', github: 'x/y' }],
};

const persistArgs = {
    applicationId: '5f0c2b52-0000-4000-8000-000000000001',
    userId:        '5f0c2b52-0000-4000-8000-000000000002',
    pipelineId:    '5f0c2b52-0000-4000-8000-000000000003',
    targetRole:    'Technical Services Engineer',
    archetype:     null,
};

function persistedContentJson(): { sectionOrder?: string[] } {
    const call = mockQuery.mock.calls.at(-1) as unknown as [string, unknown[]];
    return JSON.parse(call[1][3] as string);
}

describe('persistTailoredResume — canonical sectionOrder choke point', () => {
    beforeEach(() => mockQuery.mockClear());

    it('overwrites a model-echoed sectionOrder (the live regression shape)', async () => {
        const result = await persistTailoredResume({} as never, {
            ...persistArgs,
            tailoredResume: {
                ...baseResume,
                sectionOrder: ['profile', 'summary', 'experience', 'skills', 'projects', 'education', 'certifications'],
            },
        });
        expect(result).toEqual({ resumeId: persistArgs.pipelineId });
        expect(persistedContentJson().sectionOrder).toEqual([...CANONICAL_SECTION_ORDER]);
    });

    it('stamps the canonical order when the resume carries none', async () => {
        await persistTailoredResume({} as never, { ...persistArgs, tailoredResume: baseResume });
        expect(persistedContentJson().sectionOrder).toEqual([...CANONICAL_SECTION_ORDER]);
    });

    it('still skips persistence (fail-closed gate) on a non-object resume', async () => {
        const result = await persistTailoredResume({} as never, { ...persistArgs, tailoredResume: 'nonsense' });
        expect(result).toBeNull();
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
