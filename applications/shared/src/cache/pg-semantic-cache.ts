/**
 * @format
 * PgSemanticCache — Postgres+pgvector semantic response cache.
 *
 * Mirrors RdsVectorStore's pool/env pattern and tavily-cache's TTL/hit
 * model, but matches semantically (cosine) not by hash. Fail-open: every
 * error path degrades to a miss / no-op and emits a CacheError metric —
 * the cache must never throw into a host request.
 */

import { Pool } from 'pg';

import { emitEmfMetric } from '../emf.js';
import { PiiScrubber } from '../security/index.js';
import { TitanEmbeddingProvider } from '../rds/index.js';
import type {
    ISemanticCache,
    SemanticCacheGetInput,
    SemanticCacheGetResult,
    SemanticCachePutInput,
    SemanticCacheInvalidateInput,
} from './cache-types.js';

const NS = 'BedrockSharedSafety';

export interface SemanticCacheConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly threshold?: number;
    readonly ttlDays?: number;
    readonly efSearch?: number;
}

function normalise(q: string): string {
    return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Pool constructor, X-Ray-instrumented in Lambda so cache queries show up as
 * subsegments. Lazy-requires aws-xray-sdk-core only when running in Lambda
 * (AWS_LAMBDA_FUNCTION_NAME set) so the K8s bundle never loads it; falls back
 * to the plain Pool on any error. capturePostgres wraps the pg module.
 */
function resolvePoolCtor(): typeof Pool {
    if (!process.env['AWS_LAMBDA_FUNCTION_NAME']) return Pool;
    try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const AWSXRay = require('aws-xray-sdk-core') as {
            capturePostgres: (pg: unknown) => { Pool: typeof Pool };
        };
        return AWSXRay.capturePostgres(require('pg')).Pool;
        /* eslint-enable @typescript-eslint/no-require-imports */
    } catch {
        return Pool;
    }
}

export class PgSemanticCache implements ISemanticCache {
    private readonly pool: Pool;
    private readonly embedder = TitanEmbeddingProvider.fromEnvironment();
    private readonly scrubber = new PiiScrubber();
    private readonly threshold: number;
    private readonly ttlDays: number;
    private readonly efSearch: number;

    constructor(cfg: SemanticCacheConfig) {
        const PoolCtor = resolvePoolCtor();
        this.pool = new PoolCtor({
            host: cfg.host, port: cfg.port, database: cfg.database,
            user: cfg.user, password: cfg.password,
            max: 3, idleTimeoutMillis: 30_000, ssl: false,
        });
        this.threshold = cfg.threshold
            ?? Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? '0.95');
        this.ttlDays = cfg.ttlDays
            ?? Number(process.env.SEMANTIC_CACHE_TTL_DAYS ?? '7');
        this.efSearch = cfg.efSearch ?? 40;
    }

    static fromEnvironment(extra?: Partial<SemanticCacheConfig>): PgSemanticCache {
        return new PgSemanticCache({
            host: process.env.RDS_HOST ?? '',
            port: Number(process.env.RDS_PORT ?? '5432'),
            database: process.env.RDS_DB_NAME ?? '',
            user: process.env.RDS_USER ?? '',
            password: process.env.RDS_PASSWORD ?? '',
            ...extra,
        });
    }

    private scrubbedNormalised(text: string): string {
        return this.scrubber.scrub(normalise(text)).redacted;
    }

    private async embed(text: string): Promise<number[]> {
        return this.embedder.embed(this.scrubbedNormalised(text));
    }

    async get(input: SemanticCacheGetInput): Promise<SemanticCacheGetResult> {
        try {
            const vec = await this.embed(input.queryText);
            const res = await this.pool.query<{ id: number; response: unknown; similarity: number }>(
                `WITH _ AS (SELECT set_config('hnsw.ef_search', $1, true))
                 SELECT id, response,
                        1 - (query_embedding <=> $4::vector) AS similarity
                 FROM semantic_cache, _
                 WHERE scope = $2 AND kb_tag = $3
                   AND created_at > NOW() - ($5 || ' days')::interval
                 ORDER BY query_embedding <=> $4::vector
                 LIMIT 1`,
                [String(this.efSearch), input.scope, input.kbTag,
                 `[${vec.join(',')}]`, String(this.ttlDays)],
            );
            const row = res.rows[0];
            if (row && Number(row.similarity) >= this.threshold) {
                void this.pool.query(
                    'UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = $1',
                    [row.id],
                ).catch(() => {});
                emitEmfMetric(NS, { Module: 'cache' },
                    [{ name: 'CacheHit', value: 1, unit: 'Count' }]);
                return { hit: true, response: row.response, similarity: Number(row.similarity) };
            }
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheMiss', value: 1, unit: 'Count' }]);
            return { hit: false };
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[semantic-cache] get failed — treating as miss:',
                (e as Error).message);
            return { hit: false };
        }
    }

    async put(input: SemanticCachePutInput): Promise<void> {
        try {
            const vec = await this.embed(input.queryText);
            await this.pool.query(
                `INSERT INTO semantic_cache
                   (scope, kb_tag, query_text, query_embedding, response)
                 VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
                [input.scope, input.kbTag, this.scrubbedNormalised(input.queryText),
                 `[${vec.join(',')}]`, JSON.stringify(input.response)],
            );
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[semantic-cache] put failed — skipping store:',
                (e as Error).message);
        }
    }

    async invalidate(input: SemanticCacheInvalidateInput): Promise<number> {
        try {
            const params: string[] = [];
            const clauses: string[] = [];
            if (input.scope) {
                params.push(input.scope);
                clauses.push(`scope = $${params.length}`);
            }
            if (input.kbTag) {
                params.push(input.kbTag);
                clauses.push(`kb_tag = $${params.length}`);
            }
            const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
            const res = await this.pool.query(
                `DELETE FROM semantic_cache${where}`, params,
            );
            return res.rowCount ?? 0;
        } catch (e) {
            emitEmfMetric(NS, { Module: 'cache' },
                [{ name: 'CacheError', value: 1, unit: 'Count' }]);
            console.warn('[semantic-cache] invalidate failed — no-op:',
                (e as Error).message);
            return 0;
        }
    }
}
