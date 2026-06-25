/**
 * @format
 * Article-pipeline RESEARCH-phase golden eval.
 *
 * Runs the REAL retrieval the research agent uses in production — Titan embed →
 * PgVectorRetriever over the user KB, at the SAME mode-aware depth
 * (PGVECTOR_DEPTH, imported from the shared depth table so the two cannot drift)
 * — over the golden set, then asserts each article prompt surfaces the repos it
 * is actually about (repo-recall) while off-topic negatives do not (leakage).
 *
 * The scoring core is exported as {@link runResearchEval} so the in-cluster
 * orchestrator (run-evals.ts) can run it against the cluster pool. The gated
 * `main()` below is the LOCAL path (SSM tunnel + RDS_* env), kept for ad-hoc runs.
 *
 * Local run (with an SSM tunnel to dev RDS open on :15432):
 *   RUN_ARTICLE_GOLDEN_EVAL=1 USER_ID=<uuid> \
 *   RDS_HOST=127.0.0.1 RDS_PORT=15432 RDS_DB_NAME=tucaken RDS_USER=postgres RDS_PASSWORD=<secret> RDS_SSL=require \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/article-pipeline/src/evals/run-article-eval.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';
import { PgVectorRetriever, TitanEmbeddingProvider, type RetrievedPassage } from '@bedrock/shared';

import { PGVECTOR_DEPTH } from '../agents/retrieval-depth.js';
import {
    repoRecall, distinctReposInOrder, aggregate, passesGate, formatReport,
    type GoldenArticleQuery, type ArticleQueryResult, type ArticleEvalReport,
} from './article-eval-score.js';

export const RESEARCH_MIN_RECALL_POSITIVE = Number.parseFloat(process.env['ARTICLE_EVAL_MIN_RECALL'] ?? '0.6');
export const RESEARCH_MAX_RECALL_NEGATIVE = Number.parseFloat(process.env['ARTICLE_EVAL_MAX_LEAK'] ?? '0.0');
/** Match the research agent: it queries on the first 1000 chars of the draft. */
const QUERY_CHAR_CAP = 1000;

export function loadResearchGolden(): { version: number | null; queries: GoldenArticleQuery[] } {
    const raw = readFileSync(join(__dirname, 'golden.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; queries: GoldenArticleQuery[] };
    return { version: parsed.version ?? null, queries: parsed.queries };
}

/**
 * Run the research-phase eval against an existing pool (caller owns its
 * lifecycle). Embeds via Titan from the ambient AWS env. Pure of process exit /
 * gating so both the in-cluster orchestrator and the local CLI can reuse it.
 */
export async function runResearchEval(pool: Pool, userId: string): Promise<ArticleEvalReport> {
    const embedder  = TitanEmbeddingProvider.fromEnvironment();
    const retriever = new PgVectorRetriever(pool, embedder);
    const { queries: golden } = loadResearchGolden();

    const results: ArticleQueryResult[] = [];
    for (const g of golden) {
        const depth = PGVECTOR_DEPTH[g.mode];
        const passages: RetrievedPassage[] = await retriever.retrieve(userId, g.prompt.slice(0, QUERY_CHAR_CAP), {
            maxProfiles:     depth.maxProfiles,
            maxChunks:       depth.maxChunks,
            neighbourRadius: depth.neighbourRadius,
            ...(depth.boostByRepoSignals ? { boostByRepoSignals: depth.boostByRepoSignals } : {}),
        });
        const retrievedRepos = distinctReposInOrder(passages.map((p) => p.metadata.repo_full_name));
        results.push({
            id:             g.id,
            kind:           g.kind,
            repoRecall:     repoRecall(retrievedRepos, g.expectedRepos),
            retrievedRepos,
            retrievedCount: passages.length,
        });
    }
    return aggregate(results);
}

export function researchEvalPasses(report: ArticleEvalReport): boolean {
    return passesGate(report, RESEARCH_MIN_RECALL_POSITIVE, RESEARCH_MAX_RECALL_NEGATIVE);
}

// ── Local CLI (SSM tunnel) ───────────────────────────────────────────────────

/** Local-only pool from RDS_* (SSM tunnel). In-cluster uses run-evals.ts + PG_*. */
function localPoolFromEnv(): Pool {
    return new Pool({
        host:     process.env['RDS_HOST'],
        port:     Number.parseInt(process.env['RDS_PORT'] ?? '5432', 10),
        database: process.env['RDS_DB_NAME'],
        user:     process.env['RDS_USER'],
        password: process.env['RDS_PASSWORD'],
        ssl:      process.env['RDS_SSL'] === 'require' ? { rejectUnauthorized: false } : false,
    });
}

async function main(): Promise<void> {
    if (process.env['RUN_ARTICLE_GOLDEN_EVAL'] !== '1') {
        console.log('Article golden eval is gated. Set RUN_ARTICLE_GOLDEN_EVAL=1 (+ USER_ID, RDS_*, AWS_REGION) to run, or dispatch the in-cluster eval Job.');
        return;
    }
    const userId = process.env['USER_ID'];
    if (!userId) throw new Error('USER_ID is required');

    const pool = localPoolFromEnv();
    let report: ArticleEvalReport;
    try {
        report = await runResearchEval(pool, userId);
    } finally {
        await pool.end().catch(() => { /* best-effort */ });
    }

    console.log('\n' + formatReport(report));
    const pass = researchEvalPasses(report);
    console.log(`\n==> gate: positives ≥ ${(RESEARCH_MIN_RECALL_POSITIVE * 100).toFixed(0)}% (got ${(report.meanRecallPositive * 100).toFixed(0)}%), negatives ≤ ${(RESEARCH_MAX_RECALL_NEGATIVE * 100).toFixed(0)}% (got ${(report.meanRecallNegative * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exit(2);
}

// Only run the CLI when invoked directly, not when imported by run-evals.ts.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => { console.error('article-golden-eval failed:', err); process.exit(1); });
}
