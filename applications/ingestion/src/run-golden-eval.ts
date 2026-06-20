/**
 * @format
 * Golden-anchored eval (DeepEval track). Scores candidates against the
 * HAND-LABELLED golden set, not against another LLM draw — removing the
 * sample-vs-sample ceiling. For each golden chunk it builds:
 *   - per-chunk  = enricher.enrich(chunk)                     (today's LLM)
 *   - tier1      = tier1SkillsFromTech(file_tech_stack)       (deterministic)
 * and reports, vs golden truth:
 *   - precision  = of the candidate's skills, how many are VALID (in golden);
 *   - recall     = of the golden skills, how many the candidate found.
 * Semantic match (embedding cosine) so phrasing doesn't score as a miss.
 *
 * Env: USER_ID (req), SEM_THRESHOLD (def 0.82), PG_*, AWS_REGION, ENRICHMENT_MODEL_ID.
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

import { loadGoldenSet, goldenToMap } from './util/goldenSkills.js';
import { computeSemanticEvalMetrics } from './util/semanticEvalMetrics.js';
import { buildSkillSim } from './util/buildSkillSim.js';

const obs = bootstrapK8sObservability({ serviceName: 'golden-eval' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface ChunkRow { id: string; file_path: string; heading: string | null; content: string; file_tech_stack: string[] | null }

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

async function loadChunks(pool: Pool, ids: string[]): Promise<ChunkRow[]> {
    const { rows } = await pool.query<ChunkRow>(
        `SELECT id::text, file_path, heading, content, metadata->'file_tech_stack' AS file_tech_stack
           FROM document_embeddings WHERE id = ANY($1::uuid[])`,
        [ids],
    );
    return rows;
}

async function buildEnricher(pool: Pool, userId: string): Promise<BedrockChunkEnricher> {
    const aliasMap = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => undefined);
    const resolver = new PhraseSkillResolver(TitanEmbeddingProvider.fromEnvironment(), new SkillEmbeddingResolver(pool));
    return BedrockChunkEnricher.fromEnvironment({ pool, userId, repoName: 'golden-eval' }, aliasMap, (p) => resolver.resolve(p));
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const semThreshold = Number.parseFloat(process.env['SEM_THRESHOLD'] ?? '0.82');

    const golden = goldenToMap(loadGoldenSet());
    const pool = buildPool();
    try {
        const rows = await loadChunks(pool, [...golden.keys()]);
        log.info({ golden: golden.size, loaded: rows.length }, 'golden_eval.sample');

        const map = await new TechSkillMapRepository(pool).loadTechSkillMap();
        const enricher = await buildEnricher(pool, userId);

        const perChunk = new Map<string, string[]>();
        const tier1 = new Map<string, string[]>();
        for (const r of rows) {
            tier1.set(r.id, tier1SkillsFromTech(r.file_tech_stack ?? [], map));
            const { skills } = await enricher.enrich({ filePath: r.file_path, heading: r.heading ?? undefined, content: r.content, chunkIndex: 0, totalChunks: 1 });
            perChunk.set(r.id, skills);
        }

        const sim = await buildSkillSim([golden, perChunk, tier1], TitanEmbeddingProvider.fromEnvironment());
        const pc = computeSemanticEvalMetrics(golden, perChunk, sim, semThreshold);
        const t1 = computeSemanticEvalMetrics(golden, tier1, sim, semThreshold);
        log.info(
            { event: 'golden_eval.result', semThreshold,
              perChunkRecall: pc.recall, perChunkPrecision: pc.precision,
              tier1Recall: t1.recall, tier1Precision: t1.precision },
            `golden eval (vs hand-labelled truth, cos>=${semThreshold}): ` +
            `PER-CHUNK recall=${pc.recall.toFixed(3)} prec=${pc.precision.toFixed(3)} | ` +
            `TIER1 recall=${t1.recall.toFixed(3)} prec=${t1.precision.toFixed(3)}`,
        );
        await pool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(0);
    } catch (err) {
        await pool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'golden_eval.failed');
    process.exit(1);
});
