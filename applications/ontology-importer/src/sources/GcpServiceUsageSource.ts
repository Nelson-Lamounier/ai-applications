/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface GcpServiceConfig { config?: { name?: string; title?: string } }
interface GcpServicesDoc { services?: GcpServiceConfig[] }

/** Hardcoded GCP sub-categorization (service prefix → category). Default cloud_compute. */
const GCP_CATEGORY: Record<string, OntologyCategory> = {
    compute: 'cloud_compute', storage: 'cloud_storage', bigquery: 'cloud_database',
    bigtable: 'database_nosql', firestore: 'database_nosql', datastore: 'database_nosql',
    pubsub: 'message_broker', cloudfunctions: 'cloud_serverless', run: 'cloud_serverless',
    container: 'orchestration', dns: 'cloud_networking', iam: 'cloud_security', cloudkms: 'cloud_security',
    logging: 'observability', monitoring: 'observability', aiplatform: 'ai_platform',
};
export function gcpCategoryFor(prefix: string): OntologyCategory {
    return GCP_CATEGORY[prefix] ?? 'cloud_compute';
}

export function parseGcpServices(raw: GcpServicesDoc): RawImportEntry[] {
    const entries: RawImportEntry[] = [];
    for (const svc of raw.services ?? []) {
        const name = svc.config?.name ?? '';
        const prefix = name.replace(/\.googleapis\.com$/i, '').toLowerCase();
        if (!prefix) continue;
        const display = (svc.config?.title ?? prefix).replace(/ API$/, '');
        entries.push({
            source_identifier: prefix,
            proposed_canonical_name: `gcp_${prefix.replace(/[^a-z0-9]/g, '_')}`,
            proposed_display_name: display,
            keywords: [prefix, display.toLowerCase(), `gcp ${prefix}`, `google cloud ${prefix}`],
            source_metadata: { serviceName: name, prefix },
        });
    }
    return entries;
}

export class GcpServiceUsageSource implements Source {
    readonly name = 'gcp_service_usage';
    readonly ecosystem = 'gcp';
    constructor(private readonly dataFile = process.env.GCP_SERVICES_FILE ?? path.join(__dirname, 'data/gcp-services.json')) {}

    mapMetadataToCategory(entry: RawImportEntry): OntologyCategory {
        return gcpCategoryFor(String(entry.source_metadata.prefix ?? entry.source_identifier));
    }

    async *fetch(): AsyncIterable<RawImportEntry> {
        const doc = JSON.parse(await fs.readFile(this.dataFile, 'utf-8')) as GcpServicesDoc;
        const seen = new Set<string>();
        for (const e of parseGcpServices(doc)) {
            if (seen.has(e.proposed_canonical_name)) continue;
            seen.add(e.proposed_canonical_name);
            yield e;
        }
    }
}
