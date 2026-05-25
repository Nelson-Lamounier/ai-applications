/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface AzureServicesDoc { services?: string[] }

/** Hardcoded Azure sub-categorization (spec dir → category). Default cloud_compute. */
const AZURE_CATEGORY: Record<string, OntologyCategory> = {
    storage: 'cloud_storage', compute: 'cloud_compute', 'cosmos-db': 'database_nosql', sql: 'cloud_database',
    cognitiveservices: 'ai_platform', containerservice: 'orchestration', network: 'cloud_networking',
    keyvault: 'cloud_security', monitor: 'observability', eventhub: 'message_broker',
    servicebus: 'message_broker', web: 'cloud_serverless',
};
export function azureCategoryFor(dir: string): OntologyCategory {
    return AZURE_CATEGORY[dir] ?? 'cloud_compute';
}

function titleCase(dir: string): string {
    return dir
        .split(/[-_]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function parseAzureServices(raw: AzureServicesDoc): RawImportEntry[] {
    const entries: RawImportEntry[] = [];
    for (const dir of raw.services ?? []) {
        if (!dir) continue;
        entries.push({
            source_identifier: dir,
            proposed_canonical_name: `azure_${dir.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
            proposed_display_name: titleCase(dir),
            keywords: [dir, `azure ${dir}`],
            source_metadata: { dir },
        });
    }
    return entries;
}

export class AzureRestSpecsSource implements Source {
    readonly name = 'azure_rest_specs';
    readonly ecosystem = 'azure';
    constructor(private readonly dataFile = process.env.AZURE_SERVICES_FILE ?? path.join(__dirname, 'data/azure-services.json')) {}

    mapMetadataToCategory(entry: RawImportEntry): OntologyCategory {
        return azureCategoryFor(String(entry.source_metadata.dir ?? entry.source_identifier));
    }

    async *fetch(): AsyncIterable<RawImportEntry> {
        const doc = JSON.parse(await fs.readFile(this.dataFile, 'utf-8')) as AzureServicesDoc;
        const seen = new Set<string>();
        for (const e of parseAzureServices(doc)) {
            if (seen.has(e.proposed_canonical_name)) continue;
            seen.add(e.proposed_canonical_name);
            yield e;
        }
    }
}
