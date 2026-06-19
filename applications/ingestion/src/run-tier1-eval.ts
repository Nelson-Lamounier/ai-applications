/**
 * @format
 * Tier 1 eval (spec 003, Phase 6 — the gate before defaulting ENRICH_TIER1 on).
 * For a sample of chunks that CARRY file_tech_stack (the chunks Tier 1 resolves),
 * scores Tier 1's deterministic skills against the per-chunk LLM baseline:
 *   - baseline  = enricher.enrich(chunk)                       (the LLM, today)
 *   - candidate = tier1SkillsFromTech(file_tech_stack, map)    (zero model calls)
 *
 * Reports macro recall + precision PLUS the asymmetry that matters here: Tier 1
 * is file-grained (every chunk of a CDK file gets "infrastructure as code"), so
 * it will both MISS chunk-specific skills the LLM finds (recall) and ADD
 * tech-implied skills the LLM didn't emit (precision/over-tag). The numbers let a
 * human judge whether the coarser granularity is acceptable — it is NOT a blind
 * pass/fail, because the two paths produce complementary skill kinds.
 *
 * Env: USER_ID (req), REPO_FULL_NAME (opt), EVAL_SAMPLE_LIMIT (def 150), PG_*,
 *      AWS_REGION, ENRICHMENT_MODEL_ID. Exit 0 always (report, not gate).
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    TitanEmbeddingProvider,
    TechSkillMapRepository,
    tier1SkillsFromTech,
    bootstrapK8sObservability,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { computeEnrichEvalMetrics } from './util/enrichEvalMetrics.js';
import { computeSemanticEvalMetrics } from './util/semanticEvalMetrics.js';
import { buildSkillSim } from './util/buildSkillSim.js';

const obs = bootstrapK8sObservability({ serviceName: 'tier1-eval' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface SampleRow { id: string; file_path: string; chunk_index: number; heading: string | null; content: string; file_tech_stack: string[] | null }

function buildPool(): Pool {
    return new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      5,
    });
}

/** Sample chunks that CARRY file_tech_stack — the population Tier 1 resolves. */
async function loadSample(pool: Pool, userId: string, repo: string | undefined, limit: number): Promise<SampleRow[]> {
    const params: unknown[] = [userId];
    let where = "user_id = $1 AND metadata ? 'file_tech_stack' AND content <> ''";
    if (repo) { params.push(repo); where += ` AND repo_full_name = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query<SampleRow>(
        `SELECT id, file_path, chunk_index, heading, content,
                metadata->'file_tech_stack' AS file_tech_stack
           FROM document_embeddings
          WHERE ${where}
          ORDER BY file_path, chunk_index
          LIMIT $${params.length}`,
        params,
    );
    return rows;
}

async function buildEnricher(pool: Pool, userId: string, repo: string | undefined): Promise<BedrockChunkEnricher> {
    const aliasMap = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => undefined);
    const resolver = new PhraseSkillResolver(TitanEmbeddingProvider.fromEnvironment(), new SkillEmbeddingResolver(pool));
    return BedrockChunkEnricher.fromEnvironment({ pool, userId, repoName: repo ?? 'tier1-eval' }, aliasMap, (p) => resolver.resolve(p));
}

async function logTier1Result(baseline: Map<string, string[]>, candidate: Map<string, string[]>, sampleN: number, tier1Empty: number, mapSize: number): Promise<void> {
    const exact = computeEnrichEvalMetrics(baseline, candidate);
    // Semantic re-score (the metric fix): Tier 1 emits CANONICAL terms, the
    // baseline emits RAW Haiku phrasing — exact-string between dialects is
    // near-zero by construction. Match by embedding cosine instead.
    const semThreshold = Number.parseFloat(process.env['SEM_THRESHOLD'] ?? '0.82');
    const sim = await buildSkillSim([baseline, candidate], TitanEmbeddingProvider.fromEnvironment());
    const sem = computeSemanticEvalMetrics(baseline, candidate, sim, semThreshold);
    log.info(
        {
            event: 'tier1_eval.result',
            exactRecall: exact.recall, exactPrecision: exact.precision,
            semanticRecall: sem.recall, semanticPrecision: sem.precision, semThreshold,
            coverage: sampleN === 0 ? 0 : 1 - tier1Empty / sampleN,
            tier1MapSize: mapSize,
        },
        `tier1 eval: EXACT recall=${exact.recall.toFixed(3)} prec=${exact.precision.toFixed(3)} | ` +
        `SEMANTIC recall=${sem.recall.toFixed(3)} prec=${sem.precision.toFixed(3)} (cos>=${semThreshold}) over ${sampleN} chunks — ` +
        `if semantic >> exact, the 0.16 was a dialect artifact (Tier1 canonical vs raw baseline)`,
    );
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const repo = process.env['REPO_FULL_NAME'] || undefined;
    const limit = Number.parseInt(process.env['EVAL_SAMPLE_LIMIT'] ?? '150', 10) || 150;

    const pool = buildPool();
    try {
        const rows = await loadSample(pool, userId, repo, limit);
        log.info({ chunks: rows.length, files: new Set(rows.map((r) => r.file_path)).size }, 'tier1_eval.sample');

        const map = await new TechSkillMapRepository(pool).loadTechSkillMap();
        const enricher = await buildEnricher(pool, userId, repo);

        const baseline = new Map<string, string[]>();
        const candidate = new Map<string, string[]>();
        let tier1Empty = 0;
        for (const r of rows) {
            const t1 = tier1SkillsFromTech(r.file_tech_stack ?? [], map);
            if (t1.length === 0) tier1Empty += 1;
            candidate.set(r.id, t1);
            const { skills } = await enricher.enrich({ filePath: r.file_path, heading: r.heading ?? undefined, content: r.content, chunkIndex: 0, totalChunks: 1 });
            baseline.set(r.id, skills);
        }

        await logTier1Result(baseline, candidate, rows.length, tier1Empty, map.size);
        await pool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(0);
    } catch (err) {
        await pool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'tier1_eval.failed');
    process.exit(1);
});
