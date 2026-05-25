/** @format */
import type { Pool } from 'pg';

export class OntologyImportSourceRepository {
    constructor(private readonly pool: Pool) {}

    async upsertSeen(
        technologyId: string,
        source: string,
        sourceIdentifier: string,
        popularity: number | null,
        metadata: unknown,
    ): Promise<void> {
        await this.pool.query(
            `INSERT INTO ontology_import_sources
                (technology_id, source, source_identifier, popularity_in_source, source_metadata)
             VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
             ON CONFLICT (technology_id, source) DO UPDATE SET
                last_seen_at = now(), consecutive_misses = 0,
                source_identifier = EXCLUDED.source_identifier,
                popularity_in_source = EXCLUDED.popularity_in_source,
                source_metadata = EXCLUDED.source_metadata`,
            [technologyId, source, sourceIdentifier, popularity, JSON.stringify(metadata ?? {})],
        );
    }

    /** Increment misses for this source's entries not seen since runStart; returns rows updated. */
    async incrementMissesOlderThan(source: string, runStart: Date): Promise<number> {
        const { rowCount } = await this.pool.query(
            `UPDATE ontology_import_sources SET consecutive_misses = consecutive_misses + 1
             WHERE source = $1 AND last_seen_at < $2`,
            [source, runStart.toISOString()],
        );
        return rowCount ?? 0;
    }
}
