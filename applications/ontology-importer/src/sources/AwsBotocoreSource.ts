/** @format */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Source, RawImportEntry } from './Source.js';
import type { OntologyCategory } from '@bedrock/shared';

interface BotocoreDoc { metadata?: { endpointPrefix?: string; serviceAbbreviation?: string; serviceFullName?: string; serviceId?: string } }

/** Hardcoded AWS sub-categorization (endpointPrefix → category). Default cloud_compute. */
const AWS_CATEGORY: Record<string, OntologyCategory> = {
    s3: 'cloud_storage', ebs: 'cloud_storage', efs: 'cloud_storage', backup: 'cloud_storage',
    lambda: 'cloud_serverless', states: 'cloud_serverless',
    dynamodb: 'database_nosql', rds: 'cloud_database', 'rds-data': 'cloud_database', elasticache: 'database_kv',
    sqs: 'message_broker', sns: 'message_broker', events: 'message_broker', kinesis: 'message_broker',
    cloudfront: 'cloud_networking', route53: 'cloud_networking', apigateway: 'cloud_networking', ec2: 'cloud_compute',
    iam: 'cloud_security', kms: 'cloud_security', secretsmanager: 'cloud_security', wafv2: 'cloud_security',
    'cognito-idp': 'auth', cloudwatch: 'observability', logs: 'observability', textract: 'ai_platform', bedrock: 'ai_platform',
    eks: 'cloud_compute', ecr: 'cloud_compute', ecs: 'cloud_compute', cloudformation: 'iac',
};
export function awsCategoryFor(endpointPrefix: string): OntologyCategory {
    return AWS_CATEGORY[endpointPrefix] ?? 'cloud_compute';
}

export function parseBotocoreService(doc: BotocoreDoc, dirName: string): RawImportEntry {
    const m = doc.metadata ?? {};
    const prefix = (m.endpointPrefix ?? dirName).toLowerCase();
    const display = m.serviceAbbreviation ?? m.serviceFullName ?? m.serviceId ?? dirName;
    return {
        source_identifier: prefix,
        proposed_canonical_name: `aws_${prefix.replace(/[^a-z0-9]/g, '_')}`,
        proposed_display_name: display,
        keywords: [prefix, display.toLowerCase(), `aws ${prefix}`, `amazon ${prefix}`],
        source_metadata: { endpointPrefix: prefix, serviceId: m.serviceId },
    };
}

export class AwsBotocoreSource implements Source {
    readonly name = 'aws_botocore';
    readonly ecosystem = 'aws';
    constructor(private readonly dataDir = process.env.BOTOCORE_DATA_DIR ?? '/opt/botocore/botocore/data') {}

    mapMetadataToCategory(entry: RawImportEntry): OntologyCategory {
        return awsCategoryFor(String(entry.source_metadata.endpointPrefix ?? entry.source_identifier));
    }

    async *fetch(): AsyncIterable<RawImportEntry> {
        const services = await fs.readdir(this.dataDir, { withFileTypes: true });
        const seen = new Set<string>();
        for (const svc of services) {
            if (!svc.isDirectory()) continue;
            const versions = await fs.readdir(path.join(this.dataDir, svc.name)).catch(() => [] as string[]);
            const latest = versions.sort().pop();
            if (!latest) continue;
            const file = path.join(this.dataDir, svc.name, latest, 'service-2.json');
            try {
                const doc = JSON.parse(await fs.readFile(file, 'utf-8')) as BotocoreDoc;
                const e = parseBotocoreService(doc, svc.name);
                if (seen.has(e.proposed_canonical_name)) continue;
                seen.add(e.proposed_canonical_name);
                yield e;
            } catch { /* skip malformed */ }
        }
    }
}
