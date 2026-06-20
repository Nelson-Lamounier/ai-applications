/**
 * @format
 * Controlled-vocabulary enricher eval (the vocabulary fix). Enriches the golden
 * chunks with enrichTextCanonical (model emits ONLY canonical skill_ontology
 * terms + NEW: gaps) and scores the canonical output against the HAND-LABELLED
 * golden set:
 *   - precision = of the canonical skills, how many are valid (in golden);
 *   - recall    = of the golden skills, how many were found;
 *   - NEW: rate  = avg out-of-vocabulary capabilities per chunk (the vocabulary
 *                 growth signal — promote recurring ones; grown by JD demand).
 * Also logs EXACT recall (canonical output should match the canonical golden
 * verbatim) alongside semantic, to show the surface-form noise is gone.
 *
 * Env: USER_ID (req), SEM_THRESHOLD (def 0.82), PG_*, AWS_REGION, ENRICHMENT_MODEL_ID.
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    TitanEmbeddingProvider,
    bootstrapK8sObservability,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { loadGoldenSet, goldenToMap } from './util/goldenSkills.js';
import { computeEnrichEvalMetrics } from './util/enrichEvalMetrics.js';
import { computeSemanticEvalMetrics } from './util/semanticEvalMetrics.js';
import { buildSkillSim } from './util/buildSkillSim.js';

const obs = bootstrapK8sObservability({ serviceName: 'canonical-eval' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface ChunkRow { id: string; file_path: string; heading: string | null; content: string }

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
        `SELECT id::text, file_path, heading, content FROM document_embeddings WHERE id = ANY($1::uuid[])`,
        [ids],
    );
    return rows;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const semThreshold = Number.parseFloat(process.env['SEM_THRESHOLD'] ?? '0.82');

    const golden = goldenToMap(loadGoldenSet());
    const pool = buildPool();
    try {
        const ontology = new SkillOntologyRepository(pool);
        const vocabulary = await ontology.loadCanonicalNames();
        // Alias map so the enricher resolves alias phrasings ("aws dynamodb") to
        // their canonical instead of mis-queuing them as NEW: (the precision drag).
        const aliasToCanonical = await ontology.loadAliasToCanonicalMap().catch(() => undefined);
        const rows = await loadChunks(pool, [...golden.keys()]);
        log.info({ golden: golden.size, loaded: rows.length, vocab: vocabulary.length, aliases: aliasToCanonical?.size ?? 0 }, 'canonical_eval.sample');

        const enricher = BedrockChunkEnricher.fromEnvironment({ pool, userId, repoName: 'canonical-eval' }, aliasToCanonical);
        const candidate = new Map<string, string[]>();
        let newTotal = 0;
        const newSamples = new Set<string>();
        for (const r of rows) {
            const { canonical, newSkills } = await enricher.enrichTextCanonical(vocabulary, r.file_path, r.content, r.heading ?? undefined);
            candidate.set(r.id, canonical);
            newTotal += newSkills.length;
            for (const n of newSkills) newSamples.add(n);
        }

        const exact = computeEnrichEvalMetrics(golden, candidate);
        const sim = await buildSkillSim([golden, candidate], TitanEmbeddingProvider.fromEnvironment());
        const sem = computeSemanticEvalMetrics(golden, candidate, sim, semThreshold);
        log.info(
            { event: 'canonical_eval.result', vocab: vocabulary.length,
              exactRecall: exact.recall, exactPrecision: exact.precision,
              semanticRecall: sem.recall, semanticPrecision: sem.precision, semThreshold,
              newRatePerChunk: rows.length === 0 ? 0 : Number((newTotal / rows.length).toFixed(2)),
              newSkillsSample: [...newSamples].slice(0, 30) },
            `canonical eval (vs golden truth): EXACT recall=${exact.recall.toFixed(3)} prec=${exact.precision.toFixed(3)} | ` +
            `SEMANTIC recall=${sem.recall.toFixed(3)} prec=${sem.precision.toFixed(3)} | ` +
            `NEW:/chunk=${rows.length === 0 ? 0 : (newTotal / rows.length).toFixed(2)} (vocabulary growth queue)`,
        );
        await enricher.flushCosts().catch(() => { /* drain cost writes before pool close */ });
        await pool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(0);
    } catch (err) {
        await pool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'canonical_eval.failed');
    process.exit(1);
});
