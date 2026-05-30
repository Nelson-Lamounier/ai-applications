/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface Crate { name: string; description?: string; repository?: string; categories?: string[] }

const CRATES_MAP: Record<string, OntologyCategory> = {
    'web-programming::http-server': 'framework_web', 'web-programming': 'framework_web',
    'database': 'database_relational', 'database-implementations': 'database_relational',
    'asynchronous': 'runtime', 'command-line-utilities': 'developer_tool', 'development-tools::testing': 'testing',
};
export function cratesCategory(categories: string[]): OntologyCategory | null {
    for (const c of categories) if (CRATES_MAP[c]) return CRATES_MAP[c];
    return null;
}
export function parseCratesPage(raw: { crates?: Crate[] }): RawImportEntry[] {
    return (raw.crates ?? []).map((c) => ({
        source_identifier: c.name, proposed_canonical_name: c.name.toLowerCase(), proposed_display_name: c.name,
        description: c.description, repository_url: c.repository,
        source_metadata: { categories: c.categories ?? [] },
    }));
}

export class CratesIoSource implements Source {
    readonly name = 'crates_top_2k';
    readonly ecosystem = 'crates';
    constructor(private readonly pages = 20) {}
    mapMetadataToCategory(e: RawImportEntry): OntologyCategory | null {
        return cratesCategory((e.source_metadata.categories as string[]) ?? []);
    }
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (let p = 1; p <= this.pages; p++) {
            try {
                const res = await request(`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${p}`, { headers: { accept: 'application/json', 'user-agent': 'tucaken-ontology-importer' } });
                if (res.statusCode !== 200) break;
                yield* parseCratesPage((await res.body.json()) as { crates?: Crate[] });
            } catch { break; }
        }
    }
}
