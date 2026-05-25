/** @format */
import { describe, it, expect } from '@jest/globals';
import { OntologyImporter } from '../importer/OntologyImporter.js';
import type { OntologyWritePort, ImportSourcePort } from '../importer/OntologyImporter.js';
import { Categorizer } from '../categorization/Categorizer.js';
import { FakeSource } from '../sources/FakeSource.js';

/** In-memory OntologyWritePort backed by JS Maps so runs are idempotent. */
class InMemoryOntologyWrite implements OntologyWritePort {
    readonly techs = new Map<string, { id: string; curationLevel: string }>();
    readonly aliases = new Map<string, string>();
    private n = 0;

    async findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null> {
        return this.techs.get(canonical) ?? null;
    }
    async insertAutoImported(canonical: string): Promise<string> {
        const id = `tech-${this.n++}`;
        this.techs.set(canonical, { id, curationLevel: 'auto_imported' });
        return id;
    }
    async bumpPopularity(): Promise<void> {
        // no-op
    }
    async loadAliasMap(): Promise<Map<string, string>> {
        return new Map(this.aliases);
    }
    async insertAliases(technologyId: string, aliases: string[]): Promise<number> {
        let inserted = 0;
        for (const a of aliases) {
            if (!this.aliases.has(a)) {
                this.aliases.set(a, technologyId);
                inserted++;
            }
        }
        return inserted;
    }
}

/** In-memory ImportSourcePort. */
class InMemoryImportSources implements ImportSourcePort {
    readonly seen = new Map<string, { source: string; sourceIdentifier: string }>();
    async upsertSeen(technologyId: string, source: string, sourceIdentifier: string): Promise<void> {
        this.seen.set(`${source}:${sourceIdentifier}`, { source, sourceIdentifier });
    }
    async incrementMissesOlderThan(): Promise<number> {
        return 0;
    }
}

describe('ontology-importer in-process integration', () => {
    it('first run inserts categorized entries and is idempotent on a second run', async () => {
        const ontology = new InMemoryOntologyWrite();
        const importSources = new InMemoryImportSources();
        const importer = new OntologyImporter(new Categorizer(), ontology, importSources);
        const source = new FakeSource();

        // --- First run ---
        const first = await importer.run(source, new Date());

        expect(first.counts.entriesInserted).toBe(2); // @nestjs/core + prisma
        expect(first.counts.entriesUpdated).toBe(0);
        expect(first.unresolved.map((u) => u.source_identifier)).toContain('totally-unknown-xyz');
        expect(first.unresolved.map((u) => u.source_identifier)).not.toContain('@types/node');
        expect(ontology.aliases.size).toBeGreaterThan(0);

        // --- Second run (same source + same in-memory state) ---
        const second = await importer.run(source, new Date());

        expect(second.counts.entriesInserted).toBe(0);
        expect(second.counts.entriesUpdated).toBe(2); // both now exist → bump path
    });
});
