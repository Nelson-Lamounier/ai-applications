/**
 * @format
 * Evidence Provenance — Phase 1 of the provenance & data-quality strategy
 * (docs/evidence-provenance-strategy.md).
 *
 * Turns a completed run's already-captured retrieval data into a flat, queryable
 * trace: one row per retrieved KB passage with its repo/file, retrieval quality
 * (cosine/rerank/floor), and how it was used downstream (retrieved-but-unused,
 * cited into a verified/partial match, or demoted by a deterministic guard).
 *
 * Pure builder + a fail-open bulk insert. Observability only — it must never break
 * the pipeline, so the caller wraps the persist in try/catch.
 */

import type { Pool } from 'pg';

import { withUserRls } from './db/rls.js';

// Header on each assembled kbContext passage. Rerank captured (computeKbStats drops it).
// The source is matched with a negated class `[^,\]]+` (linear, no backtracking) rather
// than `.+?` — the path never contains a comma or `]`, and this avoids any ReDoS risk.
const HEADER_COSINE = /^\[Source:\s*([^,\]]+),\s*Cosine:\s*([0-9.]+),\s*Rerank:\s*([0-9.]+)\]/;
const HEADER_LEGACY = /^\[Source:\s*([^,\]]+),\s*Score:\s*([0-9.]+)\]/;

export type UsageStatus = 'retrieved' | 'cited_verified' | 'cited_partial' | 'demoted';
export type DemotionReason = 'vendor_provenance' | 'code_truth';

export interface ProvenanceRow {
    readonly repoFullName: string;
    readonly filePath: string;
    readonly cosine: number;
    readonly rerank: number;
    readonly passedFloor: boolean;
    readonly usageStatus: UsageStatus;
    readonly demotionReason: DemotionReason | null;
}

interface ParsedPassage { source: string; cosine: number; rerank: number; }

/** Parse every `[Source: owner/repo/file, Cosine, Rerank]` header in kbContext. */
function parsePassages(kbContext: string): ParsedPassage[] {
    const out: ParsedPassage[] = [];
    for (const line of kbContext.split('\n')) {
        const m = HEADER_COSINE.exec(line);
        if (m) {
            out.push({ source: m[1], cosine: Number.parseFloat(m[2]), rerank: Number.parseFloat(m[3]) });
            continue;
        }
        const legacy = HEADER_LEGACY.exec(line);
        if (legacy) out.push({ source: legacy[1], cosine: Number.parseFloat(legacy[2]), rerank: Number.parseFloat(legacy[2]) });
    }
    return out;
}

/** `owner/repo/path/to/file` → `owner/repo`. */
function repoOf(source: string): string {
    const parts = source.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
}

export interface ProvenanceInputs {
    /** The assembled retrieval blob (research.kbContext). */
    readonly kbContext: string;
    /** Cosine floor used for this run (kbRetrievalStats.floor). */
    readonly floor: number;
    /** Full evidence-file paths cited by the FINAL verified matches. */
    readonly verifiedFiles: ReadonlySet<string>;
    /** Full evidence-file paths cited by the FINAL partial matches. */
    readonly partialFiles: ReadonlySet<string>;
    /** Evidence-file path → which guard demoted it. Takes precedence over cited/retrieved. */
    readonly demotedFiles: ReadonlyMap<string, DemotionReason>;
}

/** Classify one passage's downstream usage (demoted > verified > partial > retrieved). */
function classifyUsage(source: string, inp: ProvenanceInputs): { usageStatus: UsageStatus; demotionReason: DemotionReason | null } {
    const demotion = inp.demotedFiles.get(source);
    if (demotion !== undefined) return { usageStatus: 'demoted', demotionReason: demotion };
    if (inp.verifiedFiles.has(source)) return { usageStatus: 'cited_verified', demotionReason: null };
    if (inp.partialFiles.has(source)) return { usageStatus: 'cited_partial', demotionReason: null };
    return { usageStatus: 'retrieved', demotionReason: null };
}

/** Build one provenance row per retrieved passage, attributing downstream usage. */
export function buildProvenanceRows(inp: ProvenanceInputs): ProvenanceRow[] {
    return parsePassages(inp.kbContext).map((p) => {
        const { usageStatus, demotionReason } = classifyUsage(p.source, inp);
        return {
            repoFullName: repoOf(p.source),
            filePath: p.source,
            cosine: p.cosine,
            rerank: p.rerank,
            passedFloor: p.cosine >= inp.floor,
            usageStatus,
            demotionReason,
        };
    });
}

export interface ProvenanceMeta {
    readonly pipelineRunId: string;
    readonly userId: string;
    readonly targetRole: string;
    readonly targetCompany: string;
    readonly agent: 'research' | 'coach';
}

const COLS = 12;

/**
 * Bulk-insert provenance rows. Returns the number inserted (0 when nothing to write).
 * The caller MUST treat failures as non-fatal — provenance is observability, never a
 * gate on the run.
 */
export async function persistEvidenceProvenance(
    pool: Pool,
    meta: ProvenanceMeta,
    rows: ReadonlyArray<ProvenanceRow>,
): Promise<number> {
    if (rows.length === 0) return 0;
    const tuples: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const b = i * COLS;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`);
        values.push(
            meta.pipelineRunId, meta.userId, meta.targetRole, meta.targetCompany, meta.agent,
            r.repoFullName, r.filePath, r.cosine, r.rerank, r.passedFloor, r.usageStatus, r.demotionReason,
        );
    }
    await withUserRls(pool, meta.userId, (client) => client.query(
        `INSERT INTO evidence_provenance
            (pipeline_run_id, user_id, target_role, target_company, agent,
             repo_full_name, file_path, cosine, rerank, passed_floor, usage_status, demotion_reason)
         VALUES ${tuples.join(',')}`,
        values,
    ));
    return rows.length;
}

// =============================================================================
// Phase 2 — per-repo data-quality rollup (docs/evidence-provenance-strategy.md)
// =============================================================================

export interface RepoQualityRow {
    readonly repoFullName: string;
    /** Passages retrieved from this repo in the run. */
    readonly passagesRetrieved: number;
    /** Of those, how many were cited (verified or partial). */
    readonly passagesCited: number;
    /** Of those, how many a deterministic guard demoted (drift / mis-attribution). */
    readonly demotedCount: number;
    /** cited / retrieved — low means noisy ingestion (lots of dead KB). */
    readonly citeRate: number;
    /** Distinct deterministic-layer technologies extracted from the repo's code. */
    readonly codeTechCount: number;
}

/** Aggregate the per-passage provenance into one quality row per repo for the run. */
export function buildRepoQualityRows(
    rows: ReadonlyArray<ProvenanceRow>,
    codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>,
): RepoQualityRow[] {
    const byRepo = new Map<string, { total: number; cited: number; demoted: number }>();
    for (const r of rows) {
        let agg = byRepo.get(r.repoFullName);
        if (agg === undefined) {
            agg = { total: 0, cited: 0, demoted: 0 };
            byRepo.set(r.repoFullName, agg);
        }
        agg.total += 1;
        if (r.usageStatus === 'cited_verified' || r.usageStatus === 'cited_partial') agg.cited += 1;
        else if (r.usageStatus === 'demoted') agg.demoted += 1;
    }
    const out: RepoQualityRow[] = [];
    for (const [repo, agg] of byRepo) {
        out.push({
            repoFullName: repo,
            passagesRetrieved: agg.total,
            passagesCited: agg.cited,
            demotedCount: agg.demoted,
            citeRate: agg.total > 0 ? Math.round((agg.cited / agg.total) * 1000) / 1000 : 0,
            codeTechCount: codeTechByRepo.get(repo)?.size ?? 0,
        });
    }
    return out;
}

const QUALITY_COLS = 9;

/**
 * Upsert per-repo quality rows for a run (natural key: pipeline_run_id + repo).
 * Fail-open at the call site — observability, never a gate.
 */
export async function persistRepoEvidenceQuality(
    pool: Pool,
    meta: { pipelineRunId: string; userId: string; targetRole: string },
    rows: ReadonlyArray<RepoQualityRow>,
): Promise<number> {
    if (rows.length === 0) return 0;
    const tuples: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const b = i * QUALITY_COLS;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        values.push(
            meta.pipelineRunId, meta.userId, meta.targetRole, r.repoFullName,
            r.passagesRetrieved, r.passagesCited, r.demotedCount, r.codeTechCount, r.citeRate,
        );
    }
    await withUserRls(pool, meta.userId, (client) => client.query(
        `INSERT INTO repo_evidence_quality
            (pipeline_run_id, user_id, target_role, repo_full_name,
             passages_retrieved, passages_cited, demoted_count, code_tech_count, cite_rate)
         VALUES ${tuples.join(',')}
         ON CONFLICT (pipeline_run_id, repo_full_name) DO UPDATE SET
             passages_retrieved = EXCLUDED.passages_retrieved,
             passages_cited     = EXCLUDED.passages_cited,
             demoted_count      = EXCLUDED.demoted_count,
             code_tech_count    = EXCLUDED.code_tech_count,
             cite_rate          = EXCLUDED.cite_rate`,
        values,
    ));
    return rows.length;
}
