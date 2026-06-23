/** @format */
import type { Pool } from 'pg';
import {
    type IChunkEnricher,
    type RawChunk,
    type FileEnrichUnit,
    tier1SkillsFromTech,
    groupChunksByFile,
    assignSkillsToChunks,
    assignSkillsByEmbedding,
    parseVector,
} from '@bedrock/shared';

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
     * Semantic fan-back lane (premium per-file). Given canonical skill names,
     * returns their skill_ontology vectors. When supplied (+ ENRICH_PER_FILE),
     * a unit skill is kept on a chunk by surface-match OR cosine(skillVec,
     * chunkVec) >= fanbackThreshold — recovering skills surface-match drops.
     * Absent -> surface-match only (today's behaviour). Fail-open.
     */
    readonly skillVectorLookup?: (names: readonly string[]) => Promise<Map<string, number[]>>;
    /** Cosine cutoff for the embedding lane. Default ENRICH_FANBACK_SIM_THRESHOLD or 0.5. */
    readonly fanbackThreshold?: number;
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
    chunk_index: number;
    content_hash: string | null;
    file_tech_stack: string[] | null;
    embedding: string | null;
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
        `SELECT id, file_path, heading, content, chunk_index, content_hash,
                metadata->'file_tech_stack' AS file_tech_stack,
                embedding::text AS embedding
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

    // Semantic fan-back (premium per-file): resolve canonical skill -> ontology
    // vector once per run (skills repeat across files). null = looked up, absent.
    const fanbackThreshold = resolveFanbackThreshold(opts.fanbackThreshold);
    const skillVectorCache = new Map<string, number[] | null>();

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
     * Zero-LLM pre-pass shared by both paths: resolve a chunk from the
     * content-hash cache (WS5) or Tier 1 (file_tech_stack -> canonical skills).
     * Writes + remembers + bumps the relevant counter on a hit. Returns true when
     * resolved (the caller skips the LLM); false leaves the row as residue.
     * Keeping this single source of truth is what makes the per-file path's
     * pre-pass byte-identical to the per-chunk path.
     */
    async function resolveCheap(row: SkippedRow): Promise<boolean> {
        // WS5 content-hash dedup: if this exact content was already enriched
        // (same user + model), copy those skills — NO LLM call. This is what
        // makes a force-reindex of unchanged content near-free.
        if (row.content_hash && cache.has(row.content_hash)) {
            await writeSkills(row.id, cache.get(row.content_hash) as string[]);
            cacheHits += 1;
            enriched += 1;
            return true;
        }
        // Tier 1: if the chunk's file tech resolves to skills, write them
        // and SKIP the LLM (the ~33.5% of chunks with file_tech_stack).
        const t1 = tier1Skills(row);
        if (t1.length > 0) {
            await writeSkills(row.id, t1);
            remember(row.content_hash, t1);
            tier1Resolved += 1;
            enriched += 1;
            return true;
        }
        return false;
    }

    async function processRow(row: SkippedRow): Promise<void> {
        try {
            if (await resolveCheap(row)) return;
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
        } catch (err) {
            // Leave the row as skipped_quota so the next run retries it.
            recordFailure(err);
        } finally {
            done += 1;
            opts.onProgress?.(done, rows.length);
        }
    }

    let stoppedEarly = false;
    const deadlineReached = (): boolean =>
        opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs;

    // Concurrency-limited worker pool over a shared cursor. Workers stop pulling
    // new rows once the deadline passes (in-flight calls still finish), so the
    // pass returns cleanly instead of being SIGKILLed at the pod deadline.
    async function runPerChunkPool(): Promise<void> {
        let cursor = 0;
        async function worker(): Promise<void> {
            while (cursor < rows.length) {
                if (deadlineReached()) { stoppedEarly = true; return; }
                const index = cursor;
                cursor += 1;
                await processRow(rows[index]);
            }
        }
        const workers = Math.max(1, Math.min(opts.concurrency ?? 10, rows.length));
        await Promise.all(Array.from({ length: workers }, () => worker()));
    }

    // ENRICH_PER_FILE: keep Tier-1 + cache as the zero-LLM per-chunk pre-pass, but
    // batch the *residue* (chunks that miss both) per file — one model call per
    // file-unit, fanned back to chunks by surface-match. Only the residue text is
    // ever sent. Falls back to the per-chunk pool when the flag is off or the
    // enricher has no enrichText (free Tier-1-only path stays byte-for-byte).
    const perFile = perFileEnabled(enricher);

    /** Adapt a residue row to the RawChunk shape groupChunksByFile expects. */
    const rowToChunk = (row: SkippedRow): RawChunk => ({
        filePath:    row.file_path,
        content:     row.content,
        heading:     row.heading ?? undefined,
        chunkIndex:  row.chunk_index,
        totalChunks: 1,
    });

    /** One model call for a file-unit, fanned back to its chunks (surface OR embedding). */
    async function enrichUnit(
        unit: FileEnrichUnit,
        idOf: (filePath: string, chunkIndex: number) => string | undefined,
        hashOf: (filePath: string, chunkIndex: number) => string | null,
        vecOf: (filePath: string, chunkIndex: number) => number[] | undefined,
    ): Promise<void> {
        let skills: string[];
        if (opts.canonicalVocab && enricher.enrichTextCanonical) {
            const { canonical, newSkills } = await enricher.enrichTextCanonical(
                opts.canonicalVocab, unit.filePath, unit.text, unit.chunks[0]?.heading);
            skills = canonical;
            newSkillsQueued += newSkills.length;
        } else {
            const r = await enricher.enrichText!(unit.filePath, unit.text, unit.chunks[0]?.heading);
            skills = r.skills;
        }
        // Fan back. Semantic lane when vectors are available (premium); else the
        // surface-match-only path (byte-identical to before).
        const skillVectors = await resolveSkillVectors(skills, skillVectorCache, opts.skillVectorLookup);
        const chunkVectors = buildChunkVectors(unit, vecOf);
        const assigned = (skillVectors.size > 0 && chunkVectors.size > 0)
            ? assignSkillsByEmbedding(unit, skills, { skillVectors, chunkVectors, threshold: fanbackThreshold })
            : assignSkillsToChunks(unit, skills, () => false);
        for (const { chunkIndex, skills: chunkSkills } of assigned) {
            const id = idOf(unit.filePath, chunkIndex);
            if (!id) continue;
            await writeSkills(id, chunkSkills);
            remember(hashOf(unit.filePath, chunkIndex), chunkSkills);
            enriched += 1;
        }
    }

    // Phase A — zero-LLM pre-pass (cache + Tier 1); returns the unresolved residue.
    // Only increment `done` for rows RESOLVED here (cache hit / Tier 1). Residue
    // rows are counted in Phase B when their unit actually completes, so that a
    // deadline cut in Phase B leaves `remaining` accurately > 0.
    async function runResiduePrepass(): Promise<SkippedRow[]> {
        const residue: SkippedRow[] = [];
        for (const row of rows) {
            if (deadlineReached()) { stoppedEarly = true; break; }
            try {
                if (await resolveCheap(row)) {
                    done += 1;
                    opts.onProgress?.(done, rows.length);
                } else {
                    residue.push(row);
                }
            } catch (err) {
                recordFailure(err);
                done += 1;
                opts.onProgress?.(done, rows.length);
            }
        }
        return residue;
    }

    async function processResiduePerFile(): Promise<void> {
        const residue = await runResiduePrepass();

        // Back-maps: `${filePath}::${chunkIndex}` -> row id / content_hash / embedding.
        const key = (filePath: string, chunkIndex: number): string => `${filePath}::${chunkIndex}`;
        const idByKey = new Map<string, string>();
        const hashByKey = new Map<string, string | null>();
        const vecByKey = new Map<string, number[]>();
        for (const row of residue) {
            idByKey.set(key(row.file_path, row.chunk_index), row.id);
            hashByKey.set(key(row.file_path, row.chunk_index), row.content_hash);
            const v = parseVector(row.embedding);
            if (v) vecByKey.set(key(row.file_path, row.chunk_index), v);
        }
        const idOf = (filePath: string, chunkIndex: number): string | undefined => idByKey.get(key(filePath, chunkIndex));
        const hashOf = (filePath: string, chunkIndex: number): string | null => hashByKey.get(key(filePath, chunkIndex)) ?? null;
        const vecOf = (filePath: string, chunkIndex: number): number[] | undefined => vecByKey.get(key(filePath, chunkIndex));

        // Phase B — per-file batching over the residue.
        const maxChars = Number(process.env.ENRICH_PER_FILE_MAX_CHARS ?? '12000') || 12000;
        const units = groupChunksByFile(residue.map(rowToChunk), maxChars);
        if (units.length > 0) {
            console.info(`[reenrichSkippedChunks] per-file residue: ${units.length} calls for ${residue.length} chunks (${(residue.length / Math.max(units.length, 1)).toFixed(1)}x fewer)`);
        }

        let cursor = 0;
        async function unitWorker(): Promise<void> {
            while (cursor < units.length) {
                if (deadlineReached()) { stoppedEarly = true; return; }
                const unit = units[cursor];
                cursor += 1;
                try {
                    await enrichUnit(unit, idOf, hashOf, vecOf);
                } catch (err) {
                    // Leave the unit's rows pending — never throw out of the pool.
                    for (const _ of unit.chunks) recordFailure(err);
                } finally {
                    // Count residue rows now that this unit is complete (success or
                    // failure). Mirrors the per-chunk loop's per-row progress so that
                    // a deadline cut before pulling the next unit leaves the un-run
                    // residue rows uncounted and `remaining` accurate.
                    done += unit.chunks.length;
                    opts.onProgress?.(done, rows.length);
                }
            }
        }
        const workers = Math.max(1, Math.min(opts.concurrency ?? 10, Math.max(units.length, 1)));
        await Promise.all(Array.from({ length: workers }, () => unitWorker()));
    }

    if (perFile) await processResiduePerFile();
    else await runPerChunkPool();

    // WS5: persist the freshly-enriched (content_hash -> skills) so the next run
    // (incl. a force-reindex) copies them instead of re-invoking the LLM.
    await persistFreshCache(pool, opts, modelId, freshCache);

    // Surface why chunks failed — a high `failed` with no trail previously masked
    // pool exhaustion as a benign "pending tail".
    logFailures(rows.length);

    return { candidates: rows.length, enriched, failed, tier1Resolved, newSkillsQueued, cacheHits, stoppedEarly, remaining: rows.length - done };
}

/**
 * Resolve the cosine threshold for the embedding fan-back lane. The option
 * value takes precedence; else the env var (numeric); else 0.5.
 */
function resolveFanbackThreshold(optValue: number | undefined): number {
    if (optValue !== undefined) return optValue;
    const env = Number(process.env['ENRICH_FANBACK_SIM_THRESHOLD']);
    return Number.isFinite(env) && env > 0 ? env : 0.5;
}

/**
 * Build a chunkIndex -> vector map for a file unit from the per-unit vecOf
 * back-map. Only chunks whose row had a parseable embedding are included;
 * chunks without a vector simply have no embedding evidence (surface-match
 * still applies via the fallback path).
 */
function buildChunkVectors(
    unit: FileEnrichUnit,
    vecOf: (filePath: string, chunkIndex: number) => number[] | undefined,
): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const c of unit.chunks) {
        const v = vecOf(unit.filePath, c.chunkIndex);
        if (v) out.set(c.chunkIndex, v);
    }
    return out;
}

/**
 * Resolve canonical skill names to their ontology vectors, using a per-run
 * cache to avoid repeated lookups (skills repeat across files). Entries that
 * the lookup does not return are cached as null so we never retry them. Fails
 * open: a lookup error returns an empty map and leaves the cache unpopulated
 * for the missing skills so the next unit can retry.
 */
async function resolveSkillVectors(
    skills: readonly string[],
    cache: Map<string, number[] | null>,
    lookup: ((names: readonly string[]) => Promise<Map<string, number[]>>) | undefined,
): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!lookup) return out;
    const missing = skills.filter((s) => !cache.has(s));
    if (missing.length > 0) {
        const looked = await lookup(missing).catch(() => new Map<string, number[]>());
        for (const s of missing) cache.set(s, looked.get(s) ?? null);
    }
    for (const s of skills) {
        const v = cache.get(s);
        if (v) out.set(s, v);
    }
    return out;
}

/**
 * The deferred path batches the residue per file only when ENRICH_PER_FILE=1 AND
 * the enricher can extract from arbitrary text. Otherwise (flag off, or a
 * free/no-op enricher) the per-chunk path runs unchanged.
 */
function perFileEnabled(enricher: IChunkEnricher): boolean {
    return process.env.ENRICH_PER_FILE === '1' && !!enricher.enrichText;
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
