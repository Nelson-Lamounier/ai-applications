/**
 * @format
 * Article-pipeline RESEARCH-phase golden eval runner (LOCAL / CI — not deployed).
 *
 * Runs the REAL retrieval the research agent uses in production — Titan embed →
 * PgVectorRetriever over the user KB, at the SAME mode-aware depth
 * (PGVECTOR_DEPTH, imported from research-agent so the two cannot drift) — over
 * the golden set, then asserts each article prompt surfaces the repos it is
 * actually about (repo-recall) while off-topic negatives do not (leakage).
 *
 * This is the research phase's eval per CLAUDE.md rule 5 ("correct grounding to
 * evidence"). Deterministic and judge-free, so it is cheap to run on every
 * prompt or retrieval change.
 *
 * Run (with an SSM tunnel to dev RDS open on :15432 — e.g. `just rds-tunnel`):
 *   RUN_ARTICLE_GOLDEN_EVAL=1 USER_ID=<uuid> \
 *   RDS_HOST=127.0.0.1 RDS_PORT=15432 RDS_DB_NAME=tucaken RDS_USER=postgres RDS_PASSWORD=<secret> RDS_SSL=require \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/article-pipeline/src/evals/run-article-eval.ts
 *
 * Env: RUN_ARTICLE_GOLDEN_EVAL=1 (gate), USER_ID, RDS_* (Pool), AWS_PROFILE/REGION,
 *      ARTICLE_EVAL_MIN_RECALL (default 0.6), ARTICLE_EVAL_MAX_LEAK (default 0.0).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';
import { PgVectorRetriever, TitanEmbeddingProvider, type RetrievedPassage } from '@bedrock/shared';

import { PGVECTOR_DEPTH } from '../agents/retrieval-depth.js';
import {
    repoRecall, distinctReposInOrder, aggregate, passesGate, formatReport,
    type GoldenArticleQuery, type ArticleQueryResult,
} from './article-eval-score.js';

const MIN_RECALL_POSITIVE = Number.parseFloat(process.env['ARTICLE_EVAL_MIN_RECALL'] ?? '0.6');
const MAX_RECALL_NEGATIVE = Number.parseFloat(process.env['ARTICLE_EVAL_MAX_LEAK'] ?? '0.0');
/** Match the research agent: it queries on the first 1000 chars of the draft. */
const QUERY_CHAR_CAP = 1000;

function loadGolden(): { version: number | null; queries: GoldenArticleQuery[] } {
    const raw = readFileSync(join(__dirname, 'golden.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; queries: GoldenArticleQuery[] };
    return { version: parsed.version ?? null, queries: parsed.queries };
}

function poolFromEnv(): Pool {
    return new Pool({
        host:     process.env['RDS_HOST'],
        port:     Number.parseInt(process.env['RDS_PORT'] ?? '5432', 10),
        database: process.env['RDS_DB_NAME'],
        user:     process.env['RDS_USER'],
        password: process.env['RDS_PASSWORD'],
        // Match RdsVectorStore: SSL over the SSM tunnel for the local eval.
        ssl:      process.env['RDS_SSL'] === 'require' ? { rejectUnauthorized: false } : false,
    });
}

async function main(): Promise<void> {
    if (process.env['RUN_ARTICLE_GOLDEN_EVAL'] !== '1') {
        console.log('Article golden eval is gated. Set RUN_ARTICLE_GOLDEN_EVAL=1 (+ USER_ID, RDS_*, AWS_REGION) to run.');
        return;
    }
    const userId = process.env['USER_ID'];
    if (!userId) throw new Error('USER_ID is required');

    const embedder  = TitanEmbeddingProvider.fromEnvironment();
    const pool      = poolFromEnv();
    const retriever = new PgVectorRetriever(pool, embedder);

    const { queries: golden } = loadGolden();
    const results: ArticleQueryResult[] = [];

    try {
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
            console.log(`  scored ${g.id} (${g.mode}, ${passages.length} passages, recall ${(repoRecall(retrievedRepos, g.expectedRepos) * 100).toFixed(0)}%)`);
        }
    } finally {
        await pool.end().catch(() => { /* best-effort */ });
    }

    const report = aggregate(results);
    console.log('\n' + formatReport(report));

    const pass = passesGate(report, MIN_RECALL_POSITIVE, MAX_RECALL_NEGATIVE);
    console.log(
        `\n==> gate: positives ≥ ${(MIN_RECALL_POSITIVE * 100).toFixed(0)}% ` +
        `(got ${(report.meanRecallPositive * 100).toFixed(0)}%), ` +
        `negatives ≤ ${(MAX_RECALL_NEGATIVE * 100).toFixed(0)}% (got ${(report.meanRecallNegative * 100).toFixed(0)}%) — ${pass ? 'PASS' : 'FAIL'}`,
    );
    if (!pass) process.exit(2);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('article-golden-eval failed:', err); process.exit(1); });
