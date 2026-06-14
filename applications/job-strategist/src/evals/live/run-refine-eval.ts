/** @format */
/**
 * Live eval for the incremental case-study REFINE phase (CLAUDE.md §5).
 *
 * Gated behind RUN_LIVE_EVALS=1 so default `jest` / CI never call Bedrock. Run
 * manually before refine-prompt changes:
 *   RUN_LIVE_EVALS=1 npx tsx src/evals/live/run-refine-eval.ts
 *
 * Wiring (not logic): build a synthetic 2-repo fixture where the prior case study
 * is grounded ONLY in the first repo and the second repo is freshly added, invoke
 * the real case-study agent in refine mode, then run the deterministic
 * runRefineGraders over the output. The graders assert the guarantee the live E2E
 * showed was at risk: the new repo must reach highlights AND challenges, not just
 * the stack. Exits non-zero if any grader fails.
 */
import {
    bedrockCaseStudyAgent,
    runRefineGraders,
    type CaseStudyContext,
    type PriorCaseStudy,
    type BasePipelineContext,
} from '@bedrock/shared';

const LIVE_ENABLED = process.env['RUN_LIVE_EVALS'] === '1';

const PRIOR_REPO = 'fixtureorg/api';
const NEW_REPO   = 'fixtureorg/web';

const prior: PriorCaseStudy = {
    tagline: 'A backend career-intelligence platform.',
    pitch: 'I built a TypeScript backend that ingests GitHub repos and synthesises career profiles.',
    decisions: [{
        title: 'Chose Aurora Postgres with pgvector over a dedicated vector DB',
        context: 'Needed embeddings storage alongside relational data.',
        decision: 'Used pgvector in Aurora to avoid a second datastore.',
        consequences: 'One database to operate; HNSW indexes for recall.',
        confidence: 'high',
        sourceSignals: { commits: [{ repoFullName: PRIOR_REPO, sha: 'a1b2c3d', authoredAt: '2026-01-01T00:00:00Z', message: 'add pgvector migration' }], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' },
    }],
    highlights: [{
        title: '5-agent profile synthesis chain in production',
        description: 'A chain of Bedrock agents runs as K8s Jobs after each ingestion.',
        sourceSignals: { commits: [{ repoFullName: PRIOR_REPO, sha: 'b2c3d4e', authoredAt: '2026-01-02T00:00:00Z', message: 'wire 5-agent chain' }], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' },
    }],
    challenges: [{
        problem: 'LLM tech-extraction recall was too low.',
        solution: 'Built a deterministic Layer-1 extractor and a parity harness; recall 0.37 → 0.67.',
        sourceSignals: { commits: [{ repoFullName: PRIOR_REPO, sha: 'c3d4e5f', authoredAt: '2026-01-03T00:00:00Z', message: 'layer-1 extractor + parity harness' }], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' },
    }],
    stack: [{ category: 'language', name: 'TypeScript', justification: 'Backend services.', sourceSignals: { commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED' } }],
};

const newRepoCommits = [
    { repoFullName: NEW_REPO, sha: 'd4e5f60', authoredAt: '2026-03-01T00:00:00Z', authorName: 'Dev', message: 'scaffold React + TanStack Router frontend' },
    { repoFullName: NEW_REPO, sha: 'e5f6071', authoredAt: '2026-03-02T00:00:00Z', authorName: 'Dev', message: 'add Cognito auth flow and protected routes' },
    { repoFullName: NEW_REPO, sha: 'f607182', authoredAt: '2026-03-03T00:00:00Z', authorName: 'Dev', message: 'integrate Stripe billing + optimistic mutations' },
];

const context: CaseStudyContext = {
    projectId: 'fixture-proj', projectName: 'Career Platform', tagline: prior.tagline, pitch: prior.pitch,
    userOverrides: {},
    components: [
        { id: 'c-api', name: 'Backend', kind: 'backend' },
        { id: 'c-web', name: 'Frontend', kind: 'frontend' },
    ],
    repositories: [
        { id: 'r-api', fullName: PRIOR_REPO, primaryLanguage: 'TypeScript', topics: ['backend'], techStack: ['node', 'pg'], defaultBranch: 'main' },
        { id: 'r-web', fullName: NEW_REPO, primaryLanguage: 'TypeScript', topics: ['frontend'], techStack: ['react', 'tanstack', 'stripe', 'cognito'], defaultBranch: 'main' },
    ],
    commits: newRepoCommits,
    pulls: [],
    kbChunks: [],
    priorCaseStudy: prior,
    refineNewRepos: [NEW_REPO],
};

async function main(): Promise<void> {
    if (!LIVE_ENABLED) {
        console.log('RUN_LIVE_EVALS not set — skipping refine live eval.');
        return;
    }
    const ctx: BasePipelineContext = {
        pipelineId: 'refine-eval', environment: 'dev',
        cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0,
        userId: 'eval-user',
    };

    console.log(`Refine eval: invoking case-study agent (refine mode) with new repo ${NEW_REPO}…`);
    const result = await bedrockCaseStudyAgent.invoke(context, ctx);
    const report = runRefineGraders({ prior, newRepos: [NEW_REPO], refined: result.data });

    for (const r of report.results) {
        console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.grader} (score ${r.score.toFixed(2)})${r.failures.length ? ' — ' + r.failures.join('; ') : ''}`);
    }
    console.log(report.pass ? 'Refine eval PASSED' : 'Refine eval FAILED');
    if (!report.pass) process.exitCode = 1;
}

main().catch((err) => {
    console.error('refine eval crashed:', err);
    process.exitCode = 1;
});
