/**
 * @format
 * Pack eval (spec 004, Phase 6 — the gate before defaulting ENRICH_PACK on).
 * Enriches the SAME sample of chunks both ways and scores packed vs per-chunk:
 *   - baseline  = enricher.enrich(chunk)        (one call per chunk — today)
 *   - candidate = enricher.enrichPack(pack)     (one call per ENRICH_PACK_SIZE chunks)
 *
 * Reports per-chunk recall + precision (vs the per-chunk baseline) + attribution
 * coverage (did every chunk get its own entry back?). Unlike per-file/Tier 1,
 * packing asks the model to do the SAME job in a shared envelope, so recall is
 * expected to HOLD — the measured risk is context-bleed (a chunk's skills
 * drifting toward its pack-mates). Set ENRICH_PACK_SIZE to sweep.
 *
 * Env: USER_ID (req), REPO_FULL_NAME (opt), EVAL_SAMPLE_LIMIT (def 120),
 *      ENRICH_PACK_SIZE (def 20), ENRICH_PACK_MAX_CHARS (def 24000), PG_*,
 *      AWS_REGION, ENRICHMENT_MODEL_ID. Exit 0 always (report).
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    TitanEmbeddingProvider,
    packChunks,
    bootstrapK8sObservability,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { computeEnrichEvalMetrics } from './util/enrichEvalMetrics.js';

const obs = bootstrapK8sObservability({ serviceName: 'pack-eval' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface SampleRow { id: string; file_path: string; chunk_index: number; heading: string | null; content: string }

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

async function loadSample(pool: Pool, userId: string, repo: string | undefined, limit: number): Promise<SampleRow[]> {
    const params: unknown[] = [userId];
    let where = "user_id = $1 AND content <> ''";
    if (repo) { params.push(repo); where += ` AND repo_full_name = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query<SampleRow>(
        `SELECT id, file_path, chunk_index, heading, content
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
    return BedrockChunkEnricher.fromEnvironment({ pool, userId, repoName: repo ?? 'pack-eval' }, aliasMap, (p) => resolver.resolve(p));
}

async function runBaseline(enricher: BedrockChunkEnricher, rows: SampleRow[]): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    for (const r of rows) {
        const { skills } = await enricher.enrich({ filePath: r.file_path, heading: r.heading ?? undefined, content: r.content, chunkIndex: 0, totalChunks: 1 });
        m.set(r.id, skills);
    }
    return m;
}

async function runPacked(enricher: BedrockChunkEnricher, rows: SampleRow[], packSize: number, maxChars: number): Promise<{ map: Map<string, string[]>; calls: number }> {
    const items = rows.map((r) => ({ key: r.id, filePath: r.file_path, content: r.content, heading: r.heading ?? undefined }));
    const packs = packChunks(items, packSize, maxChars);
    const map = new Map<string, string[]>();
    for (const pack of packs) {
        const res = await enricher.enrichPack(pack.items);
        for (const [key, e] of res) map.set(key, e.skills);
    }
    return { map, calls: packs.length };
}

function logResult(baseline: Map<string, string[]>, packed: Map<string, string[]>, sampleN: number, calls: number, packSize: number): void {
    const m = computeEnrichEvalMetrics(baseline, packed);
    const coverage = sampleN === 0 ? 0 : packed.size / sampleN;   // attribution: chunks that got their own entry
    const reduction = Number((sampleN / Math.max(calls, 1)).toFixed(1));
    log.info(
        { event: 'pack_eval.result', ...m, coverage, packSize, baselineCalls: sampleN, packedCalls: calls, callReduction: reduction },
        `pack eval (size ${packSize}): recall=${m.recall.toFixed(3)} precision=${m.precision.toFixed(3)} ` +
        `coverage=${coverage.toFixed(3)} calls ${sampleN}->${calls} (${reduction}x fewer) — recall ~1.0 + coverage ~1.0 = recall-safe`,
    );
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const repo = process.env['REPO_FULL_NAME'] || undefined;
    const limit = Number.parseInt(process.env['EVAL_SAMPLE_LIMIT'] ?? '120', 10) || 120;
    const packSize = Number.parseInt(process.env['ENRICH_PACK_SIZE'] ?? '20', 10) || 20;
    const maxChars = Number.parseInt(process.env['ENRICH_PACK_MAX_CHARS'] ?? '24000', 10) || 24_000;

    const pool = buildPool();
    try {
        const rows = await loadSample(pool, userId, repo, limit);
        log.info({ chunks: rows.length, packSize }, 'pack_eval.sample');

        const enricher = await buildEnricher(pool, userId, repo);
        const baseline = await runBaseline(enricher, rows);
        const { map: packed, calls } = await runPacked(enricher, rows, packSize, maxChars);

        logResult(baseline, packed, rows.length, calls, packSize);
        await pool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(0);
    } catch (err) {
        await pool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'pack_eval.failed');
    process.exit(1);
});
