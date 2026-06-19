/**
 * @format
 * Skill-embedding backfill entrypoint — populates `skill_ontology.embedding`
 * (migration 094) with Titan vectors so the free-text skill resolver
 * (SkillEmbeddingResolver) can map an LLM-emitted skill phrase to its nearest
 * canonical instead of relying on the ~exact alias map alone.
 *
 * Why this exists: backfillSkillEmbeddings is the reusable engine, but nothing
 * in the deployed pipeline invoked it — so the embedding column sat NULL and the
 * resolver was inert. This is the thin runner that drains it. Reference-data
 * scope (skill_ontology is global, not user-scoped), so no USER_ID and no RLS.
 * Idempotent: only rows with a NULL embedding are fetched, so re-running just
 * fills gaps (e.g. after the vocabulary grows).
 *
 * Env vars:
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD  — RDS
 *   AWS_REGION (or AWS_DEFAULT_REGION)                   — Bedrock/Titan via IRSA
 *   SKILL_BACKFILL_MAX     — optional hard cap on rows embedded this run (cost guard)
 *   SKILL_BACKFILL_BATCH   — optional rows fetched per batch (default 100)
 *
 * The embedding dimension is FIXED at 1024 to match the `vector(1024)` column +
 * HNSW index from migration 094 — a mismatch would make the resolver's cosine
 * search meaningless, so it is not configurable here.
 *
 * Exit codes: 0 = backfill complete, 1 = fatal (bad env / DB or Bedrock error).
 */

import {
    SkillOntologyRepository,
    TitanEmbeddingProvider,
    backfillSkillEmbeddings,
    bootstrapK8sObservability,
    pushFinalMetrics,
} from '@bedrock/shared';
import { Pool } from 'pg';

const obs = bootstrapK8sObservability({ serviceName: 'skill-embedding-backfill' });
const log = obs.logger;

/** The resolver's index is vector(1024); the backfill must match it exactly. */
const EMBEDDING_DIMENSION = 1024;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function main(): Promise<void> {
    const pgPool = new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      3,
    });

    const region    = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1';
    const batchSize = Number.parseInt(process.env['SKILL_BACKFILL_BATCH'] ?? '100', 10);
    const maxEnv    = process.env['SKILL_BACKFILL_MAX'];
    const max       = maxEnv ? Number.parseInt(maxEnv, 10) : undefined;

    log.info({ event: 'skill_embedding_backfill.start', region, batchSize, max: max ?? null }, 'starting skill-embedding backfill');

    try {
        const repo     = new SkillOntologyRepository(pgPool);
        const embedder = new TitanEmbeddingProvider(region, EMBEDDING_DIMENSION);

        const embedded = await backfillSkillEmbeddings(repo, embedder, { batchSize, ...(max !== undefined ? { max } : {}) });

        log.info({ event: 'skill_embedding_backfill.complete', embedded }, `embedded ${embedded} skills`);
    } finally {
        await pgPool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 'skill-embedding-backfill', 'global').catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error({ err }, 'skill_embedding_backfill.failed');
        process.exit(1);
    });
