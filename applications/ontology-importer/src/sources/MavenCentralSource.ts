/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';

interface MavenDoc { g: string; a: string }
export function parseMavenResponse(raw: { response?: { docs?: MavenDoc[] } }): RawImportEntry[] {
    return (raw.response?.docs ?? []).map((d) => ({
        source_identifier: `${d.g}:${d.a}`,
        proposed_canonical_name: d.a.toLowerCase(),
        proposed_display_name: d.a,
        keywords: [d.a, d.g, `${d.g}:${d.a}`],
        source_metadata: { groupId: d.g, artifactId: d.a },
    }));
}
export class MavenCentralSource implements Source {
    readonly name = 'maven_top_2k';
    readonly ecosystem = 'maven';
    constructor(private readonly pages = 10) {}
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (let i = 0; i < this.pages; i++) {
            try {
                const res = await request(`https://search.maven.org/solrsearch/select?q=*:*&rows=200&start=${i * 200}&wt=json`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) break;
                yield* parseMavenResponse((await res.body.json()) as { response?: { docs?: MavenDoc[] } });
            } catch { break; }
        }
    }
}
