/**
 * @format
 * Re-enrich K8s Job entrypoint — backfills `skills` for chunks previously marked
 * `enrichment_status='skipped_quota'` (they exceeded MAX_ENRICHMENT_PER_INGESTION
 * during ingestion). Enriches in place via the chunk enricher and flips the
 * status to `'ok'` — NO re-embedding, so it is cheap (~$0.001/chunk) and does not
 * touch the vectors.
 *
 * Env vars:
 *   USER_ID                                          — required (cost attribution + scope)
 *   REPO_FULL_NAME                                   — optional (scope to one repo)
 *   REENRICH_LIMIT                                   — optional (cap chunks this run)
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   AWS_REGION (or AWS_DEFAULT_REGION)               — Bedrock via IRSA
 *   ENRICHMENT_MODEL_ID                              — optional (default Haiku 4.5)
 *
 * Exit codes: 0 = complete (per-chunk failures are counted, not fatal),
 * 1 = fatal (bad env / DB unreachable).
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    TechSkillMapRepository,
    TitanEmbeddingProvider,
    bootstrapK8sObservability,
    pushFinalMetrics,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { packOptionsFromEnv, reenrichSkippedChunks } from './util/reenrichSkippedChunks.js';

const obs = bootstrapK8sObservability({ serviceName: 're-enrich' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

/**
 * Env-gated enrichment inputs, mirroring the in-job deferred pass:
 * ENRICH_CANONICAL=1 -> controlled vocabulary; ENRICH_TIER1=1 -> deterministic
 * tech->skill map applied before any LLM call. Both fail-open to undefined.
 */
async function loadEnrichmentInputs(pgPool: Pool): Promise<{
    canonicalVocab?: readonly string[];
    tier1Map?: ReadonlyMap<string, readonly string[]>;
}> {
    const canonicalVocab = process.env['ENRICH_CANONICAL'] === '1'
        ? await new SkillOntologyRepository(pgPool).loadCanonicalNames().catch(() => undefined)
        : undefined;
    const tier1Map = process.env['ENRICH_TIER1'] === '1'
        ? await new TechSkillMapRepository(pgPool).loadTechSkillMap().catch(() => undefined)
        : undefined;
    return { canonicalVocab, tier1Map };
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    // Tier gate (belt-and-braces): LLM enrichment is a premium entitlement.
    // The dispatcher (admin-api reenrich sweep) only targets premium/admin
    // users, but a mis-dispatched Job must still never bill Bedrock for a
    // free-tier user — same env contract as the ingestion worker.
    if (process.env['ENRICHMENT_DISABLED'] === '1') {
        log.info({ userId }, 're_enrich.skipped_tier — ENRICHMENT_DISABLED=1 (LLM enrichment is premium-only)');
        return;
    }
    const repoFullName = process.env['REPO_FULL_NAME'] || undefined;
    const limit = process.env['REENRICH_LIMIT']
        ? Number.parseInt(process.env['REENRICH_LIMIT'], 10)
        : undefined;

    const pgPool = new Pool({
        host:     requireEnv('PG_HOST'),
        port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
        database: requireEnv('PG_DATABASE'),
        user:     requireEnv('PG_USER'),
        password: requireEnv('PG_PASSWORD'),
        max:      5,
    });

    log.info({ userId, repoFullName, limit }, 're_enrich.start');

    try {
        // Canonicalise skills against the skill ontology (migration 092), same
        // as inline ingestion. Fail-safe: undefined map -> raw skills pass through.
        const skillAliasToCanonical = await new SkillOntologyRepository(pgPool)
            .loadAliasToCanonicalMap()
            .catch(() => undefined);
        // Embedding nearest-canonical fallback, same as inline ingestion — so the
        // re-enrich path resolves phrases the exact-alias map misses (the ontology
        // is already embedded; no backfill needed here). Fail-open via the
        // enricher's resolveSkill catch.
        const threshold = process.env['SKILL_MATCH_THRESHOLD']
            ? Number.parseFloat(process.env['SKILL_MATCH_THRESHOLD'])
            : undefined;
        const phraseResolver = new PhraseSkillResolver(
            TitanEmbeddingProvider.fromEnvironment(),
            new SkillEmbeddingResolver(pgPool, threshold),
        );
        const enricher = BedrockChunkEnricher.fromEnvironment({
            pool:     pgPool,
            userId,
            repoName: repoFullName ?? 're-enrich',
        }, skillAliasToCanonical, (p) => phraseResolver.resolve(p));

        const { canonicalVocab, tier1Map } = await loadEnrichmentInputs(pgPool);

        const result = await reenrichSkippedChunks(pgPool, enricher, {
            userId,
            repoFullName,
            limit,
            canonicalVocab,
            tier1Map,
            dedupCache: process.env['ENRICH_DEDUP'] !== '0',   // WS5 content-hash dedup (on by default)
            // Canonical packing (feature 004, deferred lane): N chunks per call so
            // the system prompt + vocabulary bill once per pack, not per chunk.
            ...packOptionsFromEnv(),
            reenrichAll: process.env['REENRICH_ALL'] === '1',
            onProgress: (done, total) => {
                if (done % 100 === 0 || done === total) {
                    log.info({ done, total, userId }, 're_enrich.progress');
                }
            },
        });

        log.info({ event: 're_enrich.complete', userId, ...result }, 're-enrich complete');
        // Drain in-flight cost-record writes BEFORE ending the pool they share —
        // otherwise the last chunks' cost INSERTs race the close and are lost.
        await enricher.flushCosts?.();
    } finally {
        await pgPool.end().catch(() => { /* best-effort drain */ });
        await pushFinalMetrics(obs.registry, 're-enrich', userId).catch(() => { /* best-effort */ });
        await obs.shutdown().catch(() => { /* flush spans */ });
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error({ err }, 're_enrich.failed');
        process.exit(1);
    });
