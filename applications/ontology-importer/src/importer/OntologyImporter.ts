/** @format */
import type { Categorizer } from '../categorization/Categorizer.js';
import type { Source, RawImportEntry } from '../sources/Source.js';
import type { ImportRunCounts } from '@bedrock/shared';
import { generateAliases } from '../aliases/AliasGenerator.js';
import { partitionAliases } from '../aliases/aliasFilters.js';

export interface OntologyWritePort {
    findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null>;
    insertAutoImported(canonical: string, display: string, category: string, source: string): Promise<string>;
    bumpPopularity(id: string, popularity: number | null): Promise<void>;
    loadAliasMap(): Promise<Map<string, string>>;
    insertAliases(technologyId: string, aliases: string[], source: string): Promise<number>;
}
export interface ImportSourcePort {
    upsertSeen(technologyId: string, source: string, sourceIdentifier: string, popularity: number | null, metadata: unknown): Promise<void>;
    incrementMissesOlderThan(source: string, runStart: Date): Promise<number>;
}

const empty = (): ImportRunCounts => ({ entriesFetched: 0, entriesInserted: 0, entriesUpdated: 0, entriesDeactivated: 0, aliasMerges: 0, unresolvedCount: 0, reviewQueueAdded: 0 });

export class OntologyImporter {
    constructor(
        private readonly categorizer: Categorizer,
        private readonly ontology: OntologyWritePort,
        private readonly importSources: ImportSourcePort,
    ) {}

    /** Returns counts + the entries that fell through layers 1-3 (for the LLM batch in Plan 3). */
    async run(source: Source, runStart: Date): Promise<{ counts: ImportRunCounts; unresolved: RawImportEntry[] }> {
        const counts = empty();
        const unresolved: RawImportEntry[] = [];
        const aliasMap = await this.ontology.loadAliasMap();

        for await (const entry of source.fetch()) {
            counts.entriesFetched++;
            if (source.keep && !source.keep(entry)) continue;

            const existing = await this.ontology.findByCanonical(entry.proposed_canonical_name);
            if (existing) {
                await this.ontology.bumpPopularity(existing.id, entry.popularity ?? null);
                await this.importSources.upsertSeen(existing.id, source.name, entry.source_identifier, entry.popularity ?? null, entry.source_metadata);
                counts.entriesUpdated++;
                continue;
            }

            const layer3 = source.mapMetadataToCategory?.(entry) ?? null;
            const result = this.categorizer.classify(entry, source.ecosystem, layer3);
            if (result.decision === 'no') continue;
            if (result.decision !== 'yes' || !result.category) {
                counts.unresolvedCount++;
                unresolved.push(entry);
                continue;
            }

            const id = await this.ontology.insertAutoImported(
                entry.proposed_canonical_name, entry.proposed_display_name, result.category, source.name,
            );
            const { insertable } = partitionAliases(
                generateAliases(entry, source.ecosystem), id, aliasMap,
            );
            const merged = await this.ontology.insertAliases(id, insertable, source.name);
            for (const a of insertable) aliasMap.set(a, id);
            counts.aliasMerges += merged;
            await this.importSources.upsertSeen(id, source.name, entry.source_identifier, entry.popularity ?? null, entry.source_metadata);
            counts.entriesInserted++;
        }

        counts.entriesDeactivated = 0; // deactivation pass wired in Plan 3
        return { counts, unresolved };
    }
}
