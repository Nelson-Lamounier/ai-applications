/**
 * @format
 * Skill-resolution threshold eval (CLAUDE.md rule 5) — sweeps the cosine
 * threshold and prints the precision/recall/false-merge curve over REAL data,
 * so the production `SKILL_MATCH_THRESHOLD` is chosen from evidence, not a guess.
 *
 * Ground truth, for free:
 *   - POSITIVES = the alias table. Each `alias -> canonical` is a known-correct
 *     mapping; a good resolver embeds the alias and lands on that canonical.
 *   - NEGATIVES = a curated set of phrases deliberately absent from the ontology
 *     (fast-moving engineering tail). A good resolver keeps these raw; resolving
 *     one is a false merge.
 *
 * Each phrase is embedded once (Titan) and matched to its nearest canonical +
 * similarity once; thresholds are then applied offline, so the sweep costs N
 * embeds + N nearest-queries regardless of how many thresholds are tried.
 *
 * Read-only: computes + prints, writes nothing. Env: PG_* + AWS_REGION.
 */

import {
    SkillOntologyRepository,
    TitanEmbeddingProvider,
    scoreSkillResolution,
    bootstrapK8sObservability,
    type ResolutionOutcome,
} from '@bedrock/shared';
import { Pool } from 'pg';

const obs = bootstrapK8sObservability({ serviceName: 'skill-resolution-eval' });
const log = obs.logger;

const EMBEDDING_DIMENSION = 1024;
const THRESHOLDS = [0.50, 0.55, 0.58, 0.60, 0.62, 0.65, 0.70, 0.75];

/** Phrases that are NOT in the seed ontology — resolving any is a false merge. */
const NEGATIVES = [
    'bedrock rag evaluation', 'karpenter autoscaling', 'pgvector hybrid retrieval',
    'temporal workflow orchestration', 'wasm edge runtime', 'duckdb analytics',
];

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

async function main(): Promise<void> {
    const pool = new Pool({
        host: requireEnv('PG_HOST'), port: Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'), user: requireEnv('PG_USER'), password: requireEnv('PG_PASSWORD'), max: 3,
    });
    const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1';
    const embedder = new TitanEmbeddingProvider(region, EMBEDDING_DIMENSION);

    try {
        const aliasMap = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap();
        const cases: Array<{ phrase: string; expected: string | null }> = [
            ...[...aliasMap.entries()].map(([alias, canonical]) => ({ phrase: alias, expected: canonical })),
            ...NEGATIVES.map((phrase) => ({ phrase, expected: null as string | null })),
        ];
        log.info({ positives: aliasMap.size, negatives: NEGATIVES.length }, 'skill_resolution_eval.start');

        // Embed each phrase once; record its single nearest canonical + similarity.
        const matched: Array<{ phrase: string; expected: string | null; nearest: string | null; sim: number }> = [];
        for (const c of cases) {
            const vec = await embedder.embed(c.phrase);
            const { rows } = await pool.query<{ canonical_name: string; sim: number }>(
                `SELECT canonical_name, 1 - (embedding <=> $1::vector) AS sim
                   FROM skill_ontology WHERE embedding IS NOT NULL
                  ORDER BY embedding <=> $1::vector LIMIT 1`,
                [`[${vec.join(',')}]`],
            );
            const top = rows[0];
            matched.push({ phrase: c.phrase, expected: c.expected, nearest: top?.canonical_name ?? null, sim: top?.sim ?? 0 });
        }

        // Apply each threshold offline + score.
        log.info({ event: 'skill_resolution_eval.curve' }, 'threshold  recall  precision  falseMerge  positives  negatives');
        for (const t of THRESHOLDS) {
            const outcomes: ResolutionOutcome[] = matched.map((m) => ({
                phrase: m.phrase, expected: m.expected,
                resolved: m.sim >= t ? m.nearest : null,
            }));
            const s = scoreSkillResolution(outcomes);
            log.info({
                threshold: t,
                recall: +s.recall.toFixed(3), precision: +s.precision.toFixed(3),
                falseMergeRate: +s.falseMergeRate.toFixed(3),
                positives: s.positives, negatives: s.negatives,
            }, `t=${t}  recall=${s.recall.toFixed(3)}  precision=${s.precision.toFixed(3)}  falseMerge=${s.falseMergeRate.toFixed(3)}`);
        }
    } finally {
        await pool.end().catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush */ });
    }
}

main().then(() => process.exit(0)).catch((err) => { log.error({ err }, 'skill_resolution_eval.failed'); process.exit(1); });
