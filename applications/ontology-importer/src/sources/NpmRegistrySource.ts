/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';

interface NpmDoc { name: string; description?: string; keywords?: string[]; repository?: { url?: string } }

export function parseNpmDoc(doc: NpmDoc): RawImportEntry {
    return {
        source_identifier: doc.name,
        proposed_canonical_name: doc.name,
        proposed_display_name: doc.name,
        description: doc.description,
        keywords: doc.keywords,
        repository_url: doc.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, ''),
        source_metadata: {},
    };
}

const DROP = [/^@types\//, /polyfill/i, /^is-[a-z]+$/, /^eslint-(config|plugin)-/, /^babel-(plugin|preset)-/];
export function npmKeep(e: RawImportEntry): boolean {
    return !DROP.some((re) => re.test(e.source_identifier));
}

export class NpmRegistrySource implements Source {
    readonly name = 'npm_top_5k';
    readonly ecosystem = 'npm';
    constructor(private readonly topPackages: string[]) {}
    keep(e: RawImportEntry): boolean { return npmKeep(e); }

    async *fetch(): AsyncIterable<RawImportEntry> {
        for (const name of this.topPackages) {
            try {
                const res = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) continue;
                yield parseNpmDoc((await res.body.json()) as NpmDoc);
            } catch { /* skip */ }
        }
    }
}
