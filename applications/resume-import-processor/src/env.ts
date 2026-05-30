/**
 * @format
 * Environment variable parser for the resume-import-processor K8s Job.
 * Validates required vars at startup; throws on missing.
 */

export interface ImportEnv {
  readonly importId:    string;
  readonly userId:      string;
  readonly s3Key:       string;
  readonly contentType: string;
  readonly tavilyApiKey: string | undefined;
  readonly assetsBucketName: string;
  readonly awsRegion:   string;
  readonly pg: {
    readonly host:     string;
    readonly port:     number;
    readonly database: string;
    readonly user:     string;
    readonly password: string;
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Environment for the resume-enrichment Job. It operates on already-extracted
 * career entries, so it needs no S3 key or content type — just the import to
 * enrich, the user, and Tavily/pg/region.
 */
export interface EnrichmentEnv {
  readonly importId:     string;
  readonly userId:       string;
  readonly tavilyApiKey: string | undefined;
  readonly awsRegion:    string;
  readonly pg: {
    readonly host:     string;
    readonly port:     number;
    readonly database: string;
    readonly user:     string;
    readonly password: string;
  };
}

export function parseEnrichmentEnv(): EnrichmentEnv {
  return {
    importId:     required('IMPORT_ID'),
    userId:       required('USER_ID'),
    tavilyApiKey: process.env['TAVILY_API_KEY'] || undefined,
    awsRegion:    process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
    pg: {
      host:     required('PG_HOST'),
      port:     Number.parseInt(process.env['PG_PORT'] ?? '5432', 10),
      database: required('PG_DATABASE'),
      user:     required('PG_USER'),
      password: required('PG_PASSWORD'),
    },
  };
}

export function parseEnv(): ImportEnv {
  return {
    importId:       required('IMPORT_ID'),
    userId:         required('USER_ID'),
    s3Key:          required('S3_KEY'),
    contentType:    required('CONTENT_TYPE'),
    tavilyApiKey:   process.env['TAVILY_API_KEY'] || undefined,
    assetsBucketName: required('ASSETS_BUCKET_NAME'),
    awsRegion:      process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
    pg: {
      host:     required('PG_HOST'),
      port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
      database: required('PG_DATABASE'),
      user:     required('PG_USER'),
      password: required('PG_PASSWORD'),
    },
  };
}
