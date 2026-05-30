/** @format */
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

const E = (o: Partial<RawImportEntry>): RawImportEntry => ({
    source_identifier: '',
    proposed_canonical_name: '',
    proposed_display_name: '',
    source_metadata: {},
    ...o,
});

/** Fixed entries exercising every categorization layer + the skip + uncategorizable paths. */
export const defaultFakeEntries: RawImportEntry[] = [
    // Layer 1 npm pattern hit → framework_web.
    E({ source_identifier: '@nestjs/core', proposed_canonical_name: '@nestjs/core', proposed_display_name: 'NestJS' }),
    // Layer 2 override hit → database_relational (ecosystem-agnostic).
    E({ source_identifier: 'prisma', proposed_canonical_name: 'prisma', proposed_display_name: 'Prisma' }),
    // Layer 1 npm skip pattern → dropped.
    E({ source_identifier: '@types/node', proposed_canonical_name: '@types/node', proposed_display_name: 'types' }),
    // Falls through all layers → unresolved.
    E({ source_identifier: 'totally-unknown-xyz', proposed_canonical_name: 'totally-unknown-xyz', proposed_display_name: 'X' }),
];

/** A deterministic in-memory Source for tests + local wiring. */
export class FakeSource implements Source {
    readonly name: string;
    readonly ecosystem: string;
    private readonly entries: RawImportEntry[];
    private readonly metadataMapper?: (entry: RawImportEntry) => OntologyCategory | null;

    constructor(
        entries: RawImportEntry[] = defaultFakeEntries,
        name = 'fake',
        ecosystem = 'npm',
        mapMetadataToCategory?: (entry: RawImportEntry) => OntologyCategory | null,
    ) {
        this.entries = entries;
        this.name = name;
        this.ecosystem = ecosystem;
        this.metadataMapper = mapMetadataToCategory;
    }

    async *fetch(): AsyncIterable<RawImportEntry> {
        yield* this.entries;
    }

    mapMetadataToCategory(entry: RawImportEntry): OntologyCategory | null {
        return this.metadataMapper ? this.metadataMapper(entry) : null;
    }
}
