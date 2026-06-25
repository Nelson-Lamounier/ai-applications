/** @format */
import type { Pool } from 'pg';

/**
 * Control-data sink for ontology resolution gaps (migration 109).
 *
 * Records free-text phrases that failed to canonicalise during enrichment so the
 * skill/technology ontology can be grown from real usage. Best-effort by design:
 * capture must NEVER break ingestion, so record() is synchronous + swallowing and
 * flush() never throws.
 *
 * Buffered + deduped per run (one row per distinct phrase per repo run); the
 * `ontology_gap_candidates` view aggregates occurrences across runs/users.
 */

type Queryable = Pick<Pool, 'query'>;

export interface OntologyGap {
    readonly kind: 'skill' | 'tech';
    /** Normalised (lowercased, trimmed) phrase that did not canonicalise. */
    readonly rawPhrase: string;
    /** 'raw' = no canonical found; 'low_fold' = low-confidence embedding fold (future). */
    readonly method?: 'raw' | 'low_fold';
    readonly resolvedCanonical?: string | null;
    readonly similarity?: number | null;
}

/** Run-constant context stamped onto every recorded gap. */
export interface OntologyGapContext {
    readonly userId?: string | null;
    readonly repoFullName?: string | null;
    readonly modelId?: string | null;
    readonly ontologyVersion?: number | null;
}

export interface IOntologyGapRecorder {
    record(gap: OntologyGap): void;
    flush(): Promise<void>;
}

/** No-op recorder — the default, so existing callers/evals are unaffected. */
export class NullOntologyGapRecorder implements IOntologyGapRecorder {
    record(_gap: OntologyGap): void {}
    async flush(): Promise<void> {}
}

export class RdsOntologyGapRecorder implements IOntologyGapRecorder {
    private readonly buffer = new Map<string, OntologyGap>();

    constructor(
        private readonly pool: Queryable,
        private readonly ctx: OntologyGapContext = {},
    ) {}

    record(gap: OntologyGap): void {
        const phrase = gap.rawPhrase.trim();
        if (!phrase) return;
        // Dedup per run by (kind, phrase) — keep one row per distinct phrase.
        this.buffer.set(`${gap.kind}:${phrase}`, { ...gap, rawPhrase: phrase });
    }

    async flush(): Promise<void> {
        if (this.buffer.size === 0) return;
        const gaps = [...this.buffer.values()];
        this.buffer.clear();

        // Build a single multi-row INSERT.
        const cols = 9;
        const values: unknown[] = [];
        const tuples = gaps.map((g, i) => {
            const b = i * cols;
            values.push(
                g.kind,
                g.rawPhrase,
                g.method ?? 'raw',
                g.resolvedCanonical ?? null,
                g.similarity ?? null,
                this.ctx.userId ?? null,
                this.ctx.repoFullName ?? null,
                this.ctx.modelId ?? null,
                this.ctx.ontologyVersion ?? null,
            );
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::uuid, $${b + 7}, $${b + 8}, $${b + 9})`;
        });

        try {
            await this.pool.query(
                `INSERT INTO ontology_resolution_gap
                   (kind, raw_phrase, method, resolved_canonical, similarity, user_id, repo_full_name, model_id, ontology_version)
                 VALUES ${tuples.join(', ')}`,
                values,
            );
        } catch (err) {
            // Best-effort: never let control-data capture break ingestion.
            console.debug('[ontology-gap] flush failed (non-fatal)', (err as Error).message);
        }
    }
}
