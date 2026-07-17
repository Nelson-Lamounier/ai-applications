/** @format */
import { describe, it, expect } from '@jest/globals';

import { buildCandidatesFromCaseStudy, type DiscoverySource } from '../article-topic-discovery.js';
import type { SourceSignal } from '../case-study-types.js';

function signals(over: Partial<SourceSignal> = {}): SourceSignal {
    return {
        commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED', ...over,
    };
}

const REPO = 'nelson/ai-applications';
const repoIdByName = new Map([[REPO, '987654321']]);

const caseStudy: DiscoverySource = {
    challenges: [{
        problem:  'Per-chunk LLM enrichment cost EUR5 per repo. This is the first sentence. And a second.',
        solution: 'Introduced a tiered enrichment cascade with a content-hash cache.',
        sourceSignals: signals({ commits: [{ repoFullName: REPO, sha: 'abc1234', authoredAt: '2026-01-01', message: 'cache' }] }),
    }],
    decisions: [{
        title:        'Unify on pgvector, drop Pinecone',
        context:      'Dual-store (pgvector + Pinecone) doubled write paths and cost.',
        decision:     'Consolidated retrieval onto pgvector with a role-weighted scorer.',
        consequences: 'One store, one write path.',
        confidence:   'high',
        sourceSignals: signals({ files: [{ repoFullName: REPO, path: 'src/retrieval/PgVectorRetriever.ts' }] }),
    }],
};

describe('buildCandidatesFromCaseStudy', () => {
    const base = { userId: 'u1', projectId: 'p1', pipelineRunId: 'run1', caseStudy, repoFullNames: [REPO] };

    it('emits one candidate per challenge and decision, attributed to the evidence repo', () => {
        const out = buildCandidatesFromCaseStudy({ ...base, repoIdByName });
        expect(out).toHaveLength(2);
        expect(out.every((c) => c.githubRepoId === '987654321')).toBe(true);
    });

    it('synthesises a concise title from the challenge problem (first sentence only)', () => {
        const [challenge] = buildCandidatesFromCaseStudy({ ...base, repoIdByName });
        expect(challenge!.title).toBe('Per-chunk LLM enrichment cost EUR5 per repo.');
        expect(challenge!.problem).toContain('second');
    });

    it('uses the decision title verbatim', () => {
        const decision = buildCandidatesFromCaseStudy({ ...base, repoIdByName })[1];
        expect(decision!.title).toBe('Unify on pgvector, drop Pinecone');
    });

    it('carries evidence refs (commit + file) but leaves verifiedMetrics empty (admin-confirmed)', () => {
        const out = buildCandidatesFromCaseStudy({ ...base, repoIdByName });
        expect(out[0]!.evidenceRefs).toEqual([{ type: 'commit', ref: 'abc1234' }]);
        expect(out[1]!.evidenceRefs).toEqual([{ type: 'file', ref: 'src/retrieval/PgVectorRetriever.ts' }]);
        expect(out.every((c) => (c.verifiedMetrics ?? []).length === 0)).toBe(true);
    });

    it('skips a candidate whose repo has no resolvable github_repo_id', () => {
        const out = buildCandidatesFromCaseStudy({ ...base, repoIdByName: new Map() });
        expect(out).toHaveLength(0);
    });
});
