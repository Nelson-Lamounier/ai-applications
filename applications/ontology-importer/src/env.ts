/** @format */

export type TriggeredBy = 'cronjob' | 'manual' | 'backfill';

export interface OntologyImportEnv {
    readonly pg: {
        readonly host: string; readonly port: number; readonly database: string;
        readonly user: string; readonly password: string;
    };
    readonly anthropicApiKey:     string;
    readonly triggeredBy:         TriggeredBy;
    readonly deactivationThreshold: number;
    /** Optional CSV filter of source names; undefined = all sources. */
    readonly sources?:            string[];
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

function parseTriggeredBy(raw: string): TriggeredBy {
    if (raw === 'cronjob' || raw === 'manual' || raw === 'backfill') return raw;
    throw new Error(`Invalid TRIGGERED_BY: ${raw} (expected cronjob|manual|backfill)`);
}

export function parseEnv(): OntologyImportEnv {
    const sourcesRaw = process.env['SOURCES'];
    const sources = sourcesRaw
        ? sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    return {
        pg: {
            host:     required('PG_HOST'),
            port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
            database: required('PG_DATABASE'),
            user:     required('PG_USER'),
            password: required('PG_PASSWORD'),
        },
        anthropicApiKey:      required('ANTHROPIC_API_KEY'),
        triggeredBy:          parseTriggeredBy(process.env['TRIGGERED_BY'] ?? 'cronjob'),
        deactivationThreshold: Number.parseInt(process.env['DEACTIVATION_THRESHOLD'] ?? '3', 10),
        sources,
    };
}
