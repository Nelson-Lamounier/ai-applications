/**
 * @format
 * Per-file enrichment eval (feature 002, US2 -- the gate before defaulting
 * ENRICH_PER_FILE on). For a sample of residue chunks (those with NULL/empty
 * skills, capped via PER_FILE_EVAL_LIMIT), scores the per-file candidate path
 * against the per-chunk LLM baseline:
 *
 *   baseline  = enricher.enrich(chunk)              (one call per chunk -- today)
 *   candidate = groupChunksByFile + enrichText/      (one call per file, fan-back
 *               enrichTextCanonical + assign          via assignSkillsToChunks)
 *
 * Reports macro recall + precision and the call-count reduction for each swept
 * threshold. REPORT-ONLY: no DB writes, no pipeline changes, no default flip.
 * Exit 0 always.
 *
 * Env:
 *   USER_ID                    (required)
 *   REPO_FULL_NAME             (optional -- scope to a single repo)
 *   PER_FILE_EVAL_LIMIT        (optional, default 200 -- chunk sample cap)
 *   PER_FILE_MAX_CHARS         (optional, default 12 000 -- per-unit char budget)
 *   PER_FILE_EVAL_THRESHOLDS   (optional, default "0.40,0.50,0.60,0.65" -- cosine thresholds to sweep)
 *   PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT (default 5432)
 *   AWS_REGION, ENRICHMENT_MODEL_ID
 *   USE_CANONICAL              (optional -- use enrichTextCanonical when "true")
 */

import {
    BedrockChunkEnricher,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    TitanEmbeddingProvider,
    bootstrapK8sObservability,
    parseVector,
    type RawChunk,
} from '@bedrock/shared';
import { Pool } from 'pg';

import { computeEnrichEvalMetrics } from './util/enrichEvalMetrics.js';
import { enrichUnitsOnce, fanbackCandidate } from './util/perFileEval.js';

const obs = bootstrapK8sObservability({ serviceName: 'per-file-eval' });
const log = obs.logger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

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

interface SampleRow {
    id: string;
    file_path: string;
    chunk_index: number;
    heading: string | null;
    content: string;
    embedding: string | null;
}

function toRawChunk(r: SampleRow): RawChunk {
    return {
        filePath:    r.file_path,
        chunkIndex:  r.chunk_index,
        heading:     r.heading ?? undefined,
        content:     r.content,
        totalChunks: 0,
    };
}

/** Sample residue chunks -- those with NULL or empty skills arrays. */
async function loadSample(
    pool: Pool,
    userId: string,
    repoFullName: string | undefined,
    limit: number,
): Promise<SampleRow[]> {
    const params: unknown[] = [userId];
    let where = "user_id = $1 AND content <> '' AND (skills IS NULL OR skills = '{}')";
    if (repoFullName) {
        params.push(repoFullName);
        where += ` AND repo_full_name = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query<SampleRow>(
        `SELECT id, file_path, chunk_index, heading, content, embedding::text AS embedding
           FROM document_embeddings
          WHERE ${where}
          ORDER BY file_path, chunk_index
          LIMIT $${params.length}`,
        params,
    );
    return rows;
}

async function buildEnricher(
    pool: Pool,
    userId: string,
    repoFullName: string | undefined,
): Promise<BedrockChunkEnricher> {
    const aliasMap = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => undefined);
    const resolver = new PhraseSkillResolver(
        TitanEmbeddingProvider.fromEnvironment(),
        new SkillEmbeddingResolver(pool),
    );
    return BedrockChunkEnricher.fromEnvironment(
        { pool, userId, repoName: repoFullName ?? 'per-file-eval' },
        aliasMap,
        (p: string) => resolver.resolve(p),
    );
}

// ---------------------------------------------------------------------------
// Baseline -- one enricher.enrich call per chunk (keyed by DB row id)
// ---------------------------------------------------------------------------

async function runBaseline(
    enricher: BedrockChunkEnricher,
    rows: SampleRow[],
): Promise<Map<string, string[]>> {
    const baseline = new Map<string, string[]>();
    for (const r of rows) {
        const { skills } = await enricher.enrich(toRawChunk(r));
        baseline.set(r.id, skills);
    }
    return baseline;
}

// ---------------------------------------------------------------------------
// Vocab loader
// ---------------------------------------------------------------------------

async function loadVocab(pool: Pool): Promise<string[] | undefined> {
    const aliasMap = await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => undefined);
    return aliasMap ? ([...new Set(aliasMap.values())] as string[]) : undefined;
}

// ---------------------------------------------------------------------------
// Result logger -- variant identifies surface-only vs embedding@<threshold>
// ---------------------------------------------------------------------------

function logResult(
    baseline: Map<string, string[]>,
    candidate: Map<string, string[]>,
    rows: SampleRow[],
    unitCount: number,
    candidateCalls: number,
    variant: string,
): void {
    const r = computeEnrichEvalMetrics(baseline, candidate);
    log.info(
        {
            event: 'per_file_eval.result',
            variant,
            recall:        r.recall,
            precision:     r.precision,
            chunks:        r.chunks,
            addedSkills:   r.addedSkills,
            droppedSkills: r.droppedSkills,
            baselineCalls: rows.length,
            candidateCalls,
            unitCount,
            callReduction: rows.length === 0 ? 0 : 1 - unitCount / rows.length,
        },
        `per-file eval [${variant}]: recall=${r.recall.toFixed(3)} precision=${r.precision.toFixed(3)} ` +
        `over ${r.chunks} chunks -- baseline ${rows.length} calls, candidate ${unitCount} units ` +
        `(${(100 * (1 - unitCount / Math.max(rows.length, 1))).toFixed(1)}% reduction) -- ` +
        `droppedSkills=${r.droppedSkills} addedSkills=${r.addedSkills} -- REPORT ONLY`,
    );
}

// ---------------------------------------------------------------------------
// Run body (separated from main to keep main's cyclomatic complexity <= 10)
// ---------------------------------------------------------------------------

async function run(
    pool: Pool,
    userId: string,
    repoFullName: string | undefined,
    limit: number,
    maxChars: number,
    useCanonical: boolean,
): Promise<void> {
    const rows = await loadSample(pool, userId, repoFullName, limit);
    log.info(
        { chunks: rows.length, files: new Set(rows.map((r) => r.file_path)).size },
        'per_file_eval.sample',
    );

    const idMap = new Map<string, string>(
        rows.map((r) => [`${r.file_path}::${r.chunk_index}`, r.id]),
    );

    const enricher = await buildEnricher(pool, userId, repoFullName);
    const vocab = useCanonical ? await loadVocab(pool) : undefined;

    log.info({ useCanonical, vocabSize: vocab?.length ?? 0, maxChars }, 'per_file_eval.config');

    const thresholds = (process.env['PER_FILE_EVAL_THRESHOLDS'] ?? '0.40,0.50,0.60,0.65')
        .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

    // Build the chunk-vector lookup from the embedding column fetched by loadSample.
    const vecByKey = new Map<string, number[]>();
    for (const r of rows) {
        const v = parseVector(r.embedding);
        if (v) vecByKey.set(`${r.file_path}::${r.chunk_index}`, v);
    }
    const chunkVectorOf = (f: string, i: number): number[] | undefined => vecByKey.get(`${f}::${i}`);

    const baseline = await runBaseline(enricher, rows);

    // One enrich pass; the sweep re-fans the cached skills (no extra model calls).
    const { units, callCount: candidateCalls } = await enrichUnitsOnce(rows.map(toRawChunk), enricher, { maxChars, vocab });
    const allSkills = [...new Set(units.flatMap((u) => u.skills))];
    const ontology = new SkillOntologyRepository(pool);
    const skillVectors = await ontology.loadSkillVectors(allSkills);

    const unitCount = units.length;

    // Surface-only baseline row (threshold n/a) + one row per swept threshold.
    logResult(baseline, fanbackCandidate(units, idMap, null), rows, unitCount, candidateCalls, 'surface-only');
    for (const threshold of thresholds) {
        const candidate = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf, threshold });
        logResult(baseline, candidate, rows, unitCount, candidateCalls, `embedding@${threshold}`);
    }

    await enricher.flushCosts?.().catch(() => { /* non-fatal */ });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const userId = requireEnv('USER_ID');
    const repoFullName = process.env['REPO_FULL_NAME'] || undefined;
    const limit = Number.parseInt(process.env['PER_FILE_EVAL_LIMIT'] ?? '200', 10) || 200;
    const maxChars = Number.parseInt(process.env['PER_FILE_MAX_CHARS'] ?? '12000', 10) || 12_000;
    const useCanonical = process.env['USE_CANONICAL'] === 'true';

    const pool = buildPool();
    try {
        await run(pool, userId, repoFullName, limit, maxChars, useCanonical);
        await pool.end().catch(() => { /* drain */ });
        await obs.shutdown().catch(() => { /* flush */ });
        process.exit(0);
    } catch (err) {
        await pool.end().catch(() => { /* drain */ });
        throw err;
    }
}

main().catch((err) => {
    log.error({ err }, 'per_file_eval.failed');
    process.exit(1);
});
