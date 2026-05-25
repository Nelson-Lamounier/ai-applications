/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyImporter } from './OntologyImporter.js';
import { Categorizer } from '../categorization/Categorizer.js';
import type { Source, RawImportEntry } from '../sources/Source.js';

function src(name: string, ecosystem: string, entries: RawImportEntry[]): Source {
    return { name, ecosystem, async *fetch() { yield* entries; } };
}
const E = (o: Partial<RawImportEntry>): RawImportEntry =>
    ({ source_identifier: '', proposed_canonical_name: '', proposed_display_name: '', source_metadata: {}, ...o });

describe('OntologyImporter.run', () => {
    it('inserts new categorized entries, skips uncategorizable, never overwrites curated', async () => {
        const ontologyWrite = {
            findByCanonical: jest.fn(async (n: string) => n === 'react' ? { id: 'id-react', curationLevel: 'curated' } : null),
            insertAutoImported: jest.fn(async () => 'id-new'),
            bumpPopularity: jest.fn(async () => {}),
            loadAliasMap: jest.fn(async () => new Map<string,string>()),
            insertAliases: jest.fn(async () => 0),
        };
        const importSources = { upsertSeen: jest.fn(async () => {}), incrementMissesOlderThan: jest.fn(async () => 0) };

        const source = src('npm_top_5k', 'npm', [
            E({ source_identifier: '@nestjs/core', proposed_canonical_name: '@nestjs/core', proposed_display_name: 'NestJS' }),
            E({ source_identifier: 'react', proposed_canonical_name: 'react', proposed_display_name: 'React', popularity: 1000 }),
            E({ source_identifier: '@types/node', proposed_canonical_name: '@types/node', proposed_display_name: 'types' }),
            E({ source_identifier: 'totally-unknown-xyz', proposed_canonical_name: 'totally-unknown-xyz', proposed_display_name: 'X' }),
        ]);

        const importer = new OntologyImporter(new Categorizer(), ontologyWrite as never, importSources as never);
        const { counts, unresolved } = await importer.run(source, new Date());

        expect(ontologyWrite.insertAutoImported).toHaveBeenCalledTimes(1);
        expect(ontologyWrite.bumpPopularity).toHaveBeenCalledWith('id-react', expect.anything());
        expect(counts.entriesInserted).toBe(1);
        expect(counts.entriesUpdated).toBe(1);
        expect(unresolved.map(u => u.source_identifier)).toEqual(['totally-unknown-xyz']);
    });
});
