/**
 * @format
 * Enrichment eval (feature 002, US2 — the binding merge gate). Runs the SAME
 * sample of chunks through both enrichment paths and scores the per-file path
 * against the per-chunk baseline:
 *   - baseline  = enricher.enrich(chunk)        (one call per chunk — today)
 *   - candidate = enrichText(file) + assign     (one call per file, fan by evidence)
 * Reports macro recall + precision and GATES: the per-file lever is not relied
 * upon until recall ≥ GATE_RECALL and precision ≥ GATE_PRECISION. Cost is one
 * sample (~100 chunks), not a corpus — a few cents of Haiku.
 *
 * Env: USER_ID (req), REPO_FULL_NAME (opt scope), EVAL_SAMPLE_LIMIT (def 100),
 *      GATE_RECALL (def 0.90), GATE_PRECISION (def 0.90), PG_*, AWS_REGION,
 *      ENRICHMENT_MODEL_ID. Exit 0 = gate pass, 2 = gate fail, 1 = fatal.
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    TitanEmbeddingProvider,
    groupChunksByFile,
    assignSkillsToChunks,
    bootstrapK8sObservability,
    type RawChunk,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { computeEnrichEvalMetrics } from './util/enrichEvalMetrics.js';

const obs = bootstrapK8sObservability({ serviceName: 'enrich-eval' });
const log = obs.logger;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

interface SampleRow { file_path: string; chunk_index: number; heading: string | null; content: string }

function toRawChunk(r: SampleRow): RawChunk {
    return { filePath: r.file_path, chunkIndex: r.chunk_index, heading: r.heading ?? undefined, content: r.content, totalChunks: 0 };
}

const key = (filePath: string, chunkIndex: number): string => `${filePath}::${chunkIndex}`;
const MAX_CHARS = 12_000;

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

/** Sample whole files (not random chunks) — the per-file precision risk lives in multi-chunk files. */
async function loadSample(pool: Pool, userId: string, repoFullName: string | undefined, limit: number): Promise<RawChunk[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (repoFullName) { params.push(repoFullName); where += ` AND repo_full_name = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query<SampleRow>(
        `SELECT file_path, chunk_index, heading, content
           FROM document_embeddings
          WHERE ${where}
            AND file_path IN (
                SELECT DISTINCT file_path FROM document_embeddings
                 WHERE ${where} ORDER BY file_path LIMIT 40)
          ORDER BY file_path, chunk_index
          LIMIT $${params.length}`,
        params,
    );
    return rows.map(toRawChunk);
}

async function buildEnricher(pool: Pool, userId: string, repoFullName: string | undefined): Promise<BedrockChunkEnricher> {
    const skillAliasToCanonical = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => undefined);
    const phraseResolver = new PhraseSkillResolver(TitanEmbeddingProvider.fromEnvironment(), new SkillEmbeddingResolver(pool));
    return BedrockChunkEnricher.fromEnvironment(
        { pool, userId, repoName: repoFullName ?? 'enrich-eval' },
        skillAliasToCanonical,
        (p) => phraseResolver.resolve(p),
    );
}

async function runBaseline(enricher: BedrockChunkEnricher, chunks: RawChunk[]): Promise<Map<string, string[]>> {
    const baseline = new Map<string, string[]>();
    for (const c of chunks) {
        const { skills } = await enricher.enrich(c);
        baseline.set(key(c.filePath, c.chunkIndex), skills);
    }
    return baseline;
}

async function runCandidate(enricher: BedrockChunkEnricher, chunks: RawChunk[]): Promise<Map<string, string[]>> {
    const candidate = new Map<string, string[]>();
    for (const unit of groupChunksByFile(chunks, MAX_CHARS)) {
        const { skills } = await enricher.enrichText(unit.filePath, unit.text, unit.chunks[0]?.heading);
        for (const a of assignSkillsToChunks(unit, skills, () => false)) {
            candidate.set(key(unit.filePath, a.chunkIndex), a.skills);
        }
    }
    return candidate;
}

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const repoFullName = process.env['REPO_FULL_NAME'] || undefined;
    const limit = Number.parseInt(process.env['EVAL_SAMPLE_LIMIT'] ?? '100', 10) || 100;
    const gateRecall = Number.parseFloat(process.env['GATE_RECALL'] ?? '0.90');
    const gatePrecision = Number.parseFloat(process.env['GATE_PRECISION'] ?? '0.90');

    const pgPool = buildPool();
    try {
        const chunks = await loadSample(pgPool, userId, repoFullName, limit);
        log.info({ chunks: chunks.length, files: new Set(chunks.map(c => c.filePath)).size }, 'enrich_eval.sample');

        const enricher = await buildEnricher(pgPool, userId, repoFullName);
        const baseline = await runBaseline(enricher, chunks);
        const candidate = await runCandidate(enricher, chunks);

        const r = computeEnrichEvalMetrics(baseline, candidate);
        const pass = r.recall >= gateRecall && r.precision >= gatePrecision;
        log.info(
            { event: 'enrich_eval.result', ...r, gateRecall, gatePrecision, pass,
              baselineCalls: chunks.length, candidateCalls: groupChunksByFile(chunks, MAX_CHARS).length },
            `enrich eval: recall=${r.recall.toFixed(3)} precision=${r.precision.toFixed(3)} ` +
            `(gate ${gateRecall}/${gatePrecision}) -> ${pass ? 'PASS' : 'FAIL'}`,
        );
        await pgPool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(pass ? 0 : 2);
    } catch (err) {
        await pgPool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'enrich_eval.failed');
    process.exit(1);
});
