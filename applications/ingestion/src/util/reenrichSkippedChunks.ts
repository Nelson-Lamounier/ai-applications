/** @format */
import type { Pool } from 'pg';
import { type IChunkEnricher, tier1SkillsFromTech, withUserRls } from '@bedrock/shared';

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
    /**
     * Chunks per model call for the canonical LLM residue (feature 004 applied
     * to THIS deferred pass — with DEFER_ENRICHMENT=1 in production, this is
     * the pass where per-chunk prompt overhead actually bills). Cache hits and
     * Tier-1 rows are resolved per-row as before; only the residue is packed.
     * Requires `canonicalVocab` + `enricher.enrichPackCanonical`; 0/1/undefined
     * keeps today's per-chunk behaviour. Missing keys and pack errors fall back
     * to per-chunk (fail-safe, mirrors the inline ENRICH_PACK path).
     */
    readonly packSize?: number;
    /** Character budget per pack (guards the model's context). Default 24000. */
    readonly packMaxChars?: number;
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
 * Pack options from the worker env (shared by run-ingestion's deferred pass
 * and the run-reenrich entrypoint so the two lanes can never drift).
 * ENRICH_PACK=1 enables canonical packing; size/chars tune the pack shape.
 */
export function packOptionsFromEnv(): { packSize: number; packMaxChars: number } {
    const maxChars = Number.parseInt(process.env['ENRICH_PACK_MAX_CHARS'] ?? '24000', 10) || 24_000;
    if (process.env['ENRICH_PACK'] !== '1') return { packSize: 0, packMaxChars: maxChars };
    const packSize = Number.parseInt(process.env['ENRICH_PACK_SIZE'] ?? '20', 10) || 20;
    return { packSize, packMaxChars: maxChars };
}

/**
 * Method-aware model id for the WS5 dedup-cache key: canonical and free-text
 * enrichment share a Bedrock model but produce DIFFERENT skills, so the key
 * folds in the method (+ vocab size, so vocabulary growth re-enriches rather
 * than serving stale canonical skills).
 */
function dedupModelId(enricher: IChunkEnricher | undefined, opts: ReenrichOptions): string {
    if (!enricher) return 'tier1-only';
    const base = enricher.modelId ?? 'unknown';
    return opts.canonicalVocab ? `${base}#canon:${opts.canonicalVocab.length}` : base;
}

interface PackConfig { packSize: number; maxChars: number; enabled: boolean }

/** Canonical packing is active only when asked for AND the canonical pack path exists. */
function resolvePackConfig(opts: ReenrichOptions, enricher: IChunkEnricher | undefined): PackConfig {
    const packSize = Math.trunc(opts.packSize ?? 0);
    const maxChars = Math.max(1_000, Math.trunc(opts.packMaxChars ?? 24_000));
    const enabled = packSize > 1 && !!opts.canonicalVocab && !!enricher?.enrichPackCanonical;
    return { packSize, maxChars, enabled };
}

/** Greedy grouping: a pack closes at `packSize` chunks or `maxChars` characters. */
function groupIntoPacks(rows: readonly SkippedRow[], packSize: number, maxChars: number): SkippedRow[][] {
    const packs: SkippedRow[][] = [];
    let current: SkippedRow[] = [];
    let chars = 0;
    for (const row of rows) {
        const packFull = current.length >= packSize || (current.length > 0 && chars + row.content.length > maxChars);
        if (packFull) {
            packs.push(current);
            current = [];
            chars = 0;
        }
        current.push(row);
        chars += row.content.length;
    }
    if (current.length > 0) packs.push(current);
    return packs;
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
    enricher: IChunkEnricher | undefined,
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
    // Cache scope is METHOD-aware — see dedupModelId. Without this, flipping
    // ENRICH_CANONICAL would copy the old free-text skills out of the cache.
    const modelId = dedupModelId(enricher, opts);
    /** Build the composite cache key that folds model identity into the hash. */
    const cacheKey = (hash: string): string => `${hash}#${modelId}`;
    const cache = await loadEnrichmentCache(pool, opts, rows, modelId, cacheKey);
    const freshCache = new Map<string, string[]>();
    const remember = (hash: string | null, skills: string[]): void => {
        if (hash) { const k = cacheKey(hash); cache.set(k, skills); freshCache.set(k, skills); }
    };

    let enriched = 0;
    let failed = 0;
    let tier1Resolved = 0;
    let newSkillsQueued = 0;
    let cacheHits = 0;
    let done = 0;
    // Sample the first few per-chunk failures so a silent mass-failure is
    // diagnosable (previously the catch swallowed every error, hiding a pool
    // exhaustion that left ~46% of a repo `pending` with no log trail).
    const failureSamples: string[] = [];
    const recordFailure = (err: unknown): void => {
        failed += 1;
        if (failureSamples.length < 5) failureSamples.push(err instanceof Error ? err.message : String(err));
    };
    const logFailures = (total: number): void => {
        if (failed > 0) console.warn(`[reenrichSkippedChunks] ${failed}/${total} chunks failed enrichment; sample errors: ${JSON.stringify(failureSamples)}`);
    };

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

    /**
     * Residue LLM path — controlled-vocab or free-text. Called only when
     * an enricher is present; extracted to keep `processRow` under complexity 10.
     */
    async function enrichWithLlm(row: SkippedRow, e: IChunkEnricher): Promise<void> {
        if (opts.canonicalVocab && e.enrichTextCanonical) {
            const { canonical, newSkills } = await e.enrichTextCanonical(opts.canonicalVocab, row.file_path, row.content, row.heading ?? undefined);
            await writeSkills(row.id, canonical);
            remember(row.content_hash, canonical);
            newSkillsQueued += newSkills.length;
            enriched += 1;
            return;
        }
        const { skills } = await e.enrich({
            filePath:    row.file_path,
            heading:     row.heading ?? undefined,
            content:     row.content,
            chunkIndex:  0,
            totalChunks: 1,
        });
        await writeSkills(row.id, skills);
        remember(row.content_hash, skills);
        enriched += 1;
    }

    // Canonical packing (feature 004, deferred lane): active only when the
    // caller asked for it AND the canonical path + pack method are available.
    const pack = resolvePackConfig(opts, enricher);
    const llmResidue: SkippedRow[] = [];

    /** One row fully accounted for (progress + remaining bookkeeping). */
    const markDone = (): void => {
        done += 1;
        opts.onProgress?.(done, rows.length);
    };

    async function processRow(row: SkippedRow): Promise<void> {
        let deferredToPack = false;
        try {
            // WS5 content-hash dedup: if this exact content was already enriched
            // (same user + model), copy those skills — NO LLM call. This is what
            // makes a force-reindex of unchanged content near-free.
            if (row.content_hash && cache.has(cacheKey(row.content_hash))) {
                await writeSkills(row.id, cache.get(cacheKey(row.content_hash)) as string[]);
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
            // Residue LLM path — skipped entirely when no enricher is supplied
            // (free-tier / Tier-1-only pass: zero Bedrock calls).
            if (!enricher) return;
            if (pack.enabled) {
                // Defer to the pack phase; completion is counted there so a
                // deadline stop still reports these rows as `remaining`.
                llmResidue.push(row);
                deferredToPack = true;
                return;
            }
            await enrichWithLlm(row, enricher);
        } catch (err) {
            // Leave the row as skipped_quota so the next run retries it.
            recordFailure(err);
        } finally {
            if (!deferredToPack) markDone();
        }
    }

    /** Per-chunk fallback for a residue row (pack error / missing key). */
    async function fallBackPerChunk(row: SkippedRow): Promise<void> {
        try {
            await enrichWithLlm(row, enricher as IChunkEnricher);
        } catch (err) {
            recordFailure(err);
        } finally {
            markDone();
        }
    }

    /** Apply one pack's keyed results; rows the model skipped fall back per-chunk. */
    async function applyPackResults(
        pack: readonly SkippedRow[],
        byKey: ReadonlyMap<string, { canonical: string[]; newSkills: string[] }>,
    ): Promise<void> {
        for (const row of pack) {
            const split = byKey.get(row.id);
            if (!split) { await fallBackPerChunk(row); continue; }
            try {
                await writeSkills(row.id, split.canonical);
                remember(row.content_hash, split.canonical);
                newSkillsQueued += split.newSkills.length;
                enriched += 1;
            } catch (err) {
                recordFailure(err);
            } finally {
                markDone();
            }
        }
    }

    /**
     * Pack phase: group the LLM residue into packs and resolve each with ONE
     * canonical model call. Deadline-aware like the row workers — packs not
     * dispatched by the wall stay `pending` and resume next sync.
     */
    async function enrichResidueInPacks(): Promise<void> {
        const vocab = opts.canonicalVocab;
        if (!vocab) return;
        for (const group of groupIntoPacks(llmResidue, pack.packSize, pack.maxChars)) {
            if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
                stoppedEarly = true;
                return;
            }
            try {
                const byKey = await (enricher as IChunkEnricher).enrichPackCanonical!(
                    vocab,
                    group.map((r) => ({ key: r.id, filePath: r.file_path, content: r.content, heading: r.heading ?? undefined })),
                );
                await applyPackResults(group, byKey);
            } catch {
                // Whole-pack transport error: fall every row back to per-chunk
                // (mirrors the inline ENRICH_PACK fail-safe — never zero-skill).
                for (const row of group) await fallBackPerChunk(row);
            }
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

    // Pack phase: resolve the deferred canonical residue, many chunks per call.
    // Its own per-pack deadline check makes a wall hit leave the rest `pending`.
    if (llmResidue.length > 0) {
        await enrichResidueInPacks();
    }

    // WS5: persist the freshly-enriched (content_hash -> skills) so the next run
    // (incl. a force-reindex) copies them instead of re-invoking the LLM.
    await persistFreshCache(pool, opts, modelId, freshCache);

    // Surface why chunks failed — a high `failed` with no trail previously masked
    // pool exhaustion as a benign "pending tail".
    logFailures(rows.length);

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
 * run through the shared `withUserRls` helper, so it is genuinely RLS-scoped
 * (SET LOCAL ROLE tucaken_app + set_config), not just filtered by the WHERE
 * clause. Returns a composite-key (`${rawHash}#${modelId}`) → skills map; empty
 * when dedup is disabled or on any failure (degrades to full enrichment, never
 * breaks it).
 *
 * The composite key is the stored `content_hash` column value — model identity is
 * folded into the key so a PK of (user_id, content_hash) naturally scopes each entry
 * to one model without a separate `model_id` filter column. This is what makes a
 * re-run with the same model a cache hit: the stored key matches the lookup key.
 */
async function loadEnrichmentCache(
    pool: Pool, opts: ReenrichOptions, rows: readonly SkippedRow[], modelId: string,
    cacheKey: (hash: string) => string,
): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!opts.dedupCache || !opts.userId) return out;
    const userId = opts.userId;
    const rawHashes = [...new Set(rows.map((r) => r.content_hash).filter((h): h is string => !!h))];
    if (rawHashes.length === 0) return out;
    // Composite keys are the values actually stored in the content_hash column.
    const compositeKeys = rawHashes.map(cacheKey);
    try {
        await withUserRls(pool, userId, async (client) => {
            const { rows: cached } = await client.query<{ content_hash: string; skills: string[] }>(
                `SELECT content_hash, skills FROM chunk_enrichment_cache
                  WHERE user_id = $1::uuid AND content_hash = ANY($2::text[])`,
                [userId, compositeKeys],
            );
            // Key the map by composite hash — matches what processRow looks up via cacheKey().
            for (const c of cached) out.set(c.content_hash, c.skills);
        });
    } catch (err) {
        console.warn('[reenrichSkippedChunks] enrichment-cache read failed (non-fatal)', err);
    }
    return out;
}

/**
 * Batch-upsert freshly-enriched (compositeKey -> skills) for this user + model.
 * `entries` is keyed by composite key (`${rawHash}#${modelId}`) — the same key
 * stored in the `content_hash` column — so the PK (user_id, content_hash) is
 * unique per user × method, not just per user × raw hash.
 */
async function saveEnrichmentCache(
    pool: Pool, userId: string, modelId: string, entries: ReadonlyMap<string, string[]>,
): Promise<void> {
    const items = [...entries.entries()];
    await withUserRls(pool, userId, async (client) => {
        const values: unknown[] = [];
        const placeholders = items.map((_, i) => {
            const b = i * 4;
            return `($${b + 1}::uuid, $${b + 2}, $${b + 3}::text[], $${b + 4})`;
        }).join(', ');
        // compositeKey (already `${rawHash}#${modelId}`) is stored as content_hash;
        // model_id is preserved as a human-readable label (NOT NULL column).
        for (const [compositeKey, skills] of items) values.push(userId, compositeKey, skills, modelId);
        await client.query(
            `INSERT INTO chunk_enrichment_cache (user_id, content_hash, skills, model_id)
             VALUES ${placeholders}
             ON CONFLICT (user_id, content_hash) DO UPDATE
                 SET skills = EXCLUDED.skills, model_id = EXCLUDED.model_id, updated_at = now()`,
            values,
        );
    });
}
