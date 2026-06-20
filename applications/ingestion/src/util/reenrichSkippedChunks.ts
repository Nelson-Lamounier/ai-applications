/** @format */
import type { Pool } from 'pg';
import { type IChunkEnricher, tier1SkillsFromTech } from '@bedrock/shared';

/** Filter + bounds for a re-enrich run. */
export interface ReenrichOptions {
    /** Restrict to one user (omit = all users with skipped chunks). */
    readonly userId?: string;
    /** Restrict to one repo (omit = all repos in scope). */
    readonly repoFullName?: string;
    /** Cap chunks processed this run (omit = no cap). */
    readonly limit?: number;
    /**
     * Re-enrich EVERY chunk in scope, not just `skipped_quota`/`pending` — used
     * to re-apply an updated skill vocabulary/resolver to an already-enriched
     * corpus (a rollout). Still no re-embedding; overwrites `skills` in place.
     */
    readonly reenrichAll?: boolean;
    /** Concurrent enrich calls. Default 10. */
    readonly concurrency?: number;
    /** Progress callback (done, total). */
    readonly onProgress?: (done: number, total: number) => void;
    /**
     * Absolute epoch-ms wall by which enrichment must stop DISPATCHING new work.
     * Reaching it leaves the unprocessed rows as `pending` (the next ordinary
     * sync resumes them) and returns normally with `stoppedEarly: true`. This
     * keeps a large repo's best-effort enrichment from running into the pod's
     * `activeDeadlineSeconds` and marking an otherwise-successful Job as
     * DeadlineExceeded. Omit for no time bound.
     */
    readonly deadlineMs?: number;
    /**
     * Tier 1 of the tiered cascade (spec 003): tech_canonical -> canonical
     * skills. When present (ENRICH_TIER1=1), a chunk whose `file_tech_stack`
     * yields skills is resolved deterministically here — NO model call — and the
     * LLM enricher is invoked only for the residue. file_tech_stack is on the
     * chunk by now (stampUserEvidenceMetadata runs before this deferred pass).
     */
    readonly tier1Map?: ReadonlyMap<string, readonly string[]>;
    /**
     * Controlled vocabulary (the vocabulary fix). When present (ENRICH_CANONICAL=1),
     * each chunk is enriched via enrichTextCanonical — the model emits ONLY these
     * canonical skill_ontology terms (canonical by construction, so the
     * `d.skills && query.skills` overlap lane fires) + a NEW: growth queue.
     */
    readonly canonicalVocab?: readonly string[];
    /**
     * Content-hash enrichment dedup (WS5). When true, a chunk whose content_hash
     * is already in chunk_enrichment_cache (same user + model) copies the cached
     * skills instead of calling the LLM — so a force-reindex of an unchanged repo
     * is near-free. Requires `userId`. Strictly a cost optimisation: identical
     * content yields identical skills.
     */
    readonly dedupCache?: boolean;
}

export interface ReenrichResult {
    readonly candidates: number;
    readonly enriched: number;
    readonly failed: number;
    /** Chunks resolved by Tier 1 deterministically (no model call). */
    readonly tier1Resolved: number;
    /** Out-of-vocabulary capabilities surfaced by controlled-vocab enrichment (growth queue). */
    readonly newSkillsQueued: number;
    /** Chunks served from the content-hash cache — no LLM call (WS5). */
    readonly cacheHits: number;
    /** True when the deadline stopped dispatch before all candidates ran. */
    readonly stoppedEarly: boolean;
    /** Candidates left unprocessed (still `pending`) — resumed next sync. */
    readonly remaining: number;
}

interface SkippedRow {
    id:        string;
    file_path: string;
    heading:   string | null;
    content:   string;
    content_hash: string | null;
    file_tech_stack: string[] | null;
}

/**
 * Re-enrich chunks previously marked `enrichment_status='skipped_quota'` — i.e.
 * chunks that exceeded `MAX_ENRICHMENT_PER_INGESTION` during ingestion and so
 * carry no skills. Enriches `skills` in place via the supplied enricher and
 * flips the status to `'ok'` — NO re-embedding (the vector is untouched).
 *
 * Idempotent: a re-run only sees rows still marked `skipped_quota`, so a chunk
 * whose enrich call failed (e.g. real Bedrock throttling) stays a candidate and
 * is retried next run. Cheap (~$0.001/chunk).
 */
export async function reenrichSkippedChunks(
    pool: Pool,
    enricher: IChunkEnricher,
    opts: ReenrichOptions = {},
): Promise<ReenrichResult> {
    // Backfill targets: chunks the cap skipped ('skipped_quota') AND chunks that
    // deferred enrichment to this background pass ('pending', set by the pipeline
    // when DEFER_ENRICHMENT is on for a fast first scan).
    const conditions = opts.reenrichAll
        ? [`true`]   // rollout: every chunk in scope, regardless of enrichment_status
        : [`metadata->>'enrichment_status' IN ('skipped_quota', 'pending')`];
    const params: unknown[] = [];
    if (opts.userId) {
        params.push(opts.userId);
        conditions.push(`user_id = $${params.length}::uuid`);
    }
    if (opts.repoFullName) {
        params.push(opts.repoFullName);
        conditions.push(`repo_full_name = $${params.length}`);
    }
    const limitClause = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : '';

    const { rows } = await pool.query<SkippedRow>(
        `SELECT id, file_path, heading, content, content_hash,
                metadata->'file_tech_stack' AS file_tech_stack
           FROM document_embeddings
          WHERE ${conditions.join(' AND ')}
          ORDER BY repo_full_name, file_path, chunk_index
          ${limitClause}`,
        params,
    );

    // WS5 content-hash dedup: pre-load the cache for this run's content hashes,
    // and accumulate freshly-enriched (hash -> skills) to write back at the end.
    // Cache scope is METHOD-aware: canonical and free-text enrichment use the same
    // Bedrock model but produce DIFFERENT skills, so the key folds in the method
    // (+ vocab size, so vocabulary growth re-enriches rather than serving stale
    // canonical skills). Without this, flipping ENRICH_CANONICAL would copy the
    // old free-text skills out of the cache.
    const modelId = opts.canonicalVocab
        ? `${enricher.modelId ?? 'unknown'}#canon:${opts.canonicalVocab.length}`
        : (enricher.modelId ?? 'unknown');
    const cache = await loadEnrichmentCache(pool, opts, rows, modelId);
    const freshCache = new Map<string, string[]>();
    const remember = (hash: string | null, skills: string[]): void => {
        if (hash) { cache.set(hash, skills); freshCache.set(hash, skills); }
    };

    let enriched = 0;
    let failed = 0;
    let tier1Resolved = 0;
    let newSkillsQueued = 0;
    let cacheHits = 0;
    let done = 0;

    /** Tier 1 (deterministic, no model call): file_tech_stack -> canonical skills. */
    function tier1Skills(row: SkippedRow): string[] {
        if (!opts.tier1Map || !row.file_tech_stack) return [];
        return tier1SkillsFromTech(row.file_tech_stack, opts.tier1Map);
    }

    async function writeSkills(id: string, skills: string[]): Promise<void> {
        await pool.query(
            `UPDATE document_embeddings
                SET skills   = $1::text[],
                    metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                         '{enrichment_status}', '"ok"')
              WHERE id = $2`,
            [skills, id],
        );
    }

    async function processRow(row: SkippedRow): Promise<void> {
        try {
            // WS5 content-hash dedup: if this exact content was already enriched
            // (same user + model), copy those skills — NO LLM call. This is what
            // makes a force-reindex of unchanged content near-free.
            if (row.content_hash && cache.has(row.content_hash)) {
                await writeSkills(row.id, cache.get(row.content_hash) as string[]);
                cacheHits += 1;
                enriched += 1;
                return;
            }
            // Tier 1: if the chunk's file tech resolves to skills, write them
            // and SKIP the LLM (the ~33.5% of chunks with file_tech_stack).
            const t1 = tier1Skills(row);
            if (t1.length > 0) {
                await writeSkills(row.id, t1);
                remember(row.content_hash, t1);
                tier1Resolved += 1;
                enriched += 1;
                return;
            }
            // Controlled-vocabulary LLM (the vocabulary fix): emit ONLY canonical
            // skill_ontology terms -> the chunk is canonical, so the && lane fires.
            if (opts.canonicalVocab && enricher.enrichTextCanonical) {
                const { canonical, newSkills } = await enricher.enrichTextCanonical(opts.canonicalVocab, row.file_path, row.content, row.heading ?? undefined);
                await writeSkills(row.id, canonical);
                remember(row.content_hash, canonical);
                newSkillsQueued += newSkills.length;
                enriched += 1;
                return;
            }
            // Residue -> the free-text LLM enricher (today's path).
            const { skills } = await enricher.enrich({
                filePath:    row.file_path,
                heading:     row.heading ?? undefined,
                content:     row.content,
                chunkIndex:  0,
                totalChunks: 1,
            });
            await writeSkills(row.id, skills);
            remember(row.content_hash, skills);
            enriched += 1;
        } catch {
            // Leave the row as skipped_quota so the next run retries it.
            failed += 1;
        } finally {
            done += 1;
            opts.onProgress?.(done, rows.length);
        }
    }

    // Concurrency-limited worker pool over a shared cursor. Workers stop pulling
    // new rows once the deadline passes (in-flight calls still finish), so the
    // pass returns cleanly instead of being SIGKILLed at the pod deadline.
    let cursor = 0;
    let stoppedEarly = false;
    async function worker(): Promise<void> {
        while (cursor < rows.length) {
            if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
                stoppedEarly = true;
                return;
            }
            const index = cursor;
            cursor += 1;
            await processRow(rows[index]);
        }
    }
    const workers = Math.max(1, Math.min(opts.concurrency ?? 10, rows.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    // WS5: persist the freshly-enriched (content_hash -> skills) so the next run
    // (incl. a force-reindex) copies them instead of re-invoking the LLM.
    await persistFreshCache(pool, opts, modelId, freshCache);

    return { candidates: rows.length, enriched, failed, tier1Resolved, newSkillsQueued, cacheHits, stoppedEarly, remaining: rows.length - done };
}

/** Persist freshly-enriched cache entries when dedup is enabled. Best-effort. */
async function persistFreshCache(
    pool: Pool, opts: ReenrichOptions, modelId: string, fresh: ReadonlyMap<string, string[]>,
): Promise<void> {
    if (!opts.dedupCache || !opts.userId || fresh.size === 0) return;
    await saveEnrichmentCache(pool, opts.userId, modelId, fresh)
        .catch((err) => console.warn('[reenrichSkippedChunks] enrichment-cache write failed (non-fatal)', err));
}

/**
 * Load cached skills for this run's content hashes (same user + model). One query
 * on a dedicated connection that sets the RLS user context. Returns a hash->skills
 * map; empty when dedup is disabled or on any failure (degrades to full
 * enrichment, never breaks it).
 */
async function loadEnrichmentCache(
    pool: Pool, opts: ReenrichOptions, rows: readonly SkippedRow[], modelId: string,
): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!opts.dedupCache || !opts.userId) return out;
    const userId = opts.userId;
    const hashes = [...new Set(rows.map((r) => r.content_hash).filter((h): h is string => !!h))];
    if (hashes.length === 0) return out;
    const client = await pool.connect();
    try {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const { rows: cached } = await client.query<{ content_hash: string; skills: string[] }>(
            `SELECT content_hash, skills FROM chunk_enrichment_cache
              WHERE user_id = $1::uuid AND model_id = $2 AND content_hash = ANY($3::text[])`,
            [userId, modelId, hashes],
        );
        for (const c of cached) out.set(c.content_hash, c.skills);
    } catch (err) {
        console.warn('[reenrichSkippedChunks] enrichment-cache read failed (non-fatal)', err);
    } finally {
        client.release();
    }
    return out;
}

/** Batch-upsert freshly-enriched (content_hash -> skills) for this user + model. */
async function saveEnrichmentCache(
    pool: Pool, userId: string, modelId: string, entries: ReadonlyMap<string, string[]>,
): Promise<void> {
    const items = [...entries.entries()];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const values: unknown[] = [];
        const placeholders = items.map((_, i) => {
            const b = i * 4;
            return `($${b + 1}::uuid, $${b + 2}, $${b + 3}::text[], $${b + 4})`;
        }).join(', ');
        for (const [hash, skills] of items) values.push(userId, hash, skills, modelId);
        await client.query(
            `INSERT INTO chunk_enrichment_cache (user_id, content_hash, skills, model_id)
             VALUES ${placeholders}
             ON CONFLICT (user_id, content_hash) DO UPDATE
                 SET skills = EXCLUDED.skills, model_id = EXCLUDED.model_id, updated_at = now()`,
            values,
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
