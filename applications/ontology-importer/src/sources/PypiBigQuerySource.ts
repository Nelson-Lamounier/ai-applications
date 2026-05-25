/** @format */
import { request } from 'undici';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface PypiDoc { info?: { name?: string; summary?: string; classifiers?: string[]; keywords?: string; project_urls?: Record<string, string> } }

const CLASSIFIER_MAP: { prefix: string; category: OntologyCategory }[] = [
    { prefix: 'Framework :: Django', category: 'framework_web' },
    { prefix: 'Framework :: Flask', category: 'framework_web' },
    { prefix: 'Framework :: FastAPI', category: 'framework_web' },
    { prefix: 'Topic :: Database', category: 'database_relational' },
    { prefix: 'Topic :: Scientific/Engineering :: Artificial Intelligence', category: 'ai_platform' },
    { prefix: 'Topic :: Software Development :: Testing', category: 'testing' },
    { prefix: 'Topic :: System :: Monitoring', category: 'observability' },
];
export function pypiCategoryFromClassifiers(classifiers: string[]): OntologyCategory | null {
    for (const c of classifiers) {
        const hit = CLASSIFIER_MAP.find((m) => c.startsWith(m.prefix));
        if (hit) return hit.category;
    }
    return null;
}

export function parsePypiDoc(doc: PypiDoc): RawImportEntry {
    const info = doc.info ?? {};
    const name = (info.name ?? '').toLowerCase();
    return {
        source_identifier: name,
        proposed_canonical_name: name,
        proposed_display_name: info.name ?? name,
        description: info.summary,
        keywords: info.keywords ? info.keywords.split(/[ ,]+/).filter(Boolean) : undefined,
        repository_url: info.project_urls?.Source ?? info.project_urls?.Homepage,
        source_metadata: { classifiers: info.classifiers ?? [] },
    };
}

export class PypiBigQuerySource implements Source {
    readonly name = 'pypi_top_5k';
    readonly ecosystem = 'pypi';
    constructor(private readonly topPackages: string[]) {}
    mapMetadataToCategory(e: RawImportEntry): OntologyCategory | null {
        return pypiCategoryFromClassifiers((e.source_metadata.classifiers as string[]) ?? []);
    }
    async *fetch(): AsyncIterable<RawImportEntry> {
        for (const name of this.topPackages) {
            try {
                const res = await request(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { accept: 'application/json' } });
                if (res.statusCode !== 200) continue;
                yield parsePypiDoc((await res.body.json()) as PypiDoc);
            } catch { /* skip */ }
        }
    }
}
