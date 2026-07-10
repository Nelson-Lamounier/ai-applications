/**
 * @file config.ts
 * @description Runtime configuration for the public-api service.
 *
 * All values are sourced from environment variables injected by the
 * ``nextjs-config`` Kubernetes ConfigMap (via `envFrom.configMapRef`) and
 * the ``platform-rds-credentials`` External Secret (PG_HOST/PORT/DATABASE/
 * USER/PASSWORD). AWS credentials for the chatbot Secrets Manager call are
 * NOT configured here — the default credential provider chain resolves them
 * automatically via the EC2 Instance Profile attached to the node running
 * this pod.
 *
 * @throws {Error} If any required environment variable is missing at startup.
 */

/** Validated, typed configuration for the public-api process. */
export interface Config {
  /** AWS region — sourced from AWS_REGION / AWS_DEFAULT_REGION (ConfigMap). */
  readonly awsRegion: string;
  /**
   * KMS CMK ARN for oauth_connections token envelope encryption.
   * Sourced from `OAUTH_TOKEN_KMS_KEY_ARN` (ConfigMap, populated from the
   * SSM param `/oauth/token-encryption-key-arn`).
   */
  readonly oauthTokenKmsKeyArn: string;
  /** Postgres host — sourced from PG_HOST (ESO secret). */
  readonly pgHost: string;
  /** Postgres port — sourced from PG_PORT (ESO secret), default 5432. */
  readonly pgPort: number;
  /** Postgres database name — sourced from PG_DATABASE (ESO secret). */
  readonly pgDatabase: string;
  /** Postgres user — sourced from PG_USER (ESO secret). */
  readonly pgUser: string;
  /** Postgres password — sourced from PG_PASSWORD (ESO secret). */
  readonly pgPassword: string;
  /** TCP port the HTTP server binds to (Node.js server only). */
  readonly port: number;
  /** Allowed CORS origins — comma-separated from ALLOWED_ORIGINS env var. */
  readonly allowedOrigins: string[];
  /**
   * Secrets Manager ARN for the Bedrock chatbot API key.
   * Sourced from BEDROCK_API_KEY_SECRET_ARN (ConfigMap).
   * The value is fetched at runtime via the EC2 instance profile — never
   * stored in ConfigMap or K8s Secrets (Gap S2).
   * Optional — if absent the /api/chatbot/invoke route returns 503.
   */
  readonly bedrockApiKeySecretArn: string | undefined;
  /**
   * Full endpoint URL for the public (stateless) RAG chatbot Lambda.
   * Sourced from BEDROCK_PUBLIC_API_URL (ESO secret — public-api-bedrock).
   * Published to SSM by bedrock/api-stack at /{namePrefix}/chatbot-public-api-url.
   * Optional — if absent POST /api/chatbot/public returns 503.
   */
  readonly bedrockPublicApiUrl: string | undefined;
  /**
   * Full endpoint URL for the authenticated (session-aware) RAG chatbot Lambda.
   * Sourced from BEDROCK_AUTH_API_URL (ESO secret — public-api-bedrock).
   * Published to SSM by bedrock/api-stack at /{namePrefix}/chatbot-authenticated-api-url.
   * Optional — if absent POST /api/chatbot/authenticated returns 503.
   */
  readonly bedrockAuthApiUrl: string | undefined;
  /**
   * Secrets Manager ARN for the GitHub App JSON secret containing
   * `{ appId, privateKeyPem, webhookSecret }`. Sourced from the
   * `GITHUB_APP_SECRET_ARN` env var (ConfigMap).
   */
  readonly githubAppSecretArn: string;
  /**
   * Internal user id of the portfolio owner. Sourced from
   * PORTFOLIO_OWNER_USER_ID (ConfigMap) — the same owner-pinning concept
   * the chatbot RAG lambdas use. The owner-scoped /api/projects routes
   * filter on THIS id rather than a GitHub username, because
   * oauth_connections.username is not unique (UNIQUE is on
   * (user_id, provider)) and usernames can be renamed/reclaimed on
   * GitHub — identity, not a display handle, is the isolation key.
   * Optional — if absent the owner-scoped project routes fail closed
   * (empty list / 404) rather than guessing an owner.
   */
  readonly portfolioOwnerUserId: string | undefined;
  /**
   * Name of the dedicated article-assets S3 bucket that serves published
   * article media (no PII lives in that bucket). Sourced from
   * ARTICLE_ASSETS_BUCKET_NAME (optional ESO secret).
   * Optional — if absent GET /api/articles/images/:file returns 503.
   */
  readonly articleAssetsBucketName: string | undefined;
}

/**
 * Loads and validates configuration from environment variables.
 *
 * Fails fast at startup if required variables are absent, preventing
 * silent misconfigurations at query time.
 *
 * @returns Frozen, validated {@link Config} object.
 * @throws {Error} If any required environment variable is not set.
 */
export function loadConfig(): Config {
  const required = [
    'PG_HOST',
    'PG_DATABASE',
    'PG_USER',
    'PG_PASSWORD',
    'OAUTH_TOKEN_KMS_KEY_ARN',
    'GITHUB_APP_SECRET_ARN',
  ] as const;

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[public-api] Missing required environment variables: ${missing.join(', ')}. ` +
        'Ensure the platform-rds-credentials External Secret is mounted via envFrom.',
    );
  }

  return Object.freeze({
    // Lambda injects AWS_REGION automatically; AWS_DEFAULT_REGION kept for local dev
    awsRegion: (process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1'),
    oauthTokenKmsKeyArn: process.env['OAUTH_TOKEN_KMS_KEY_ARN'] as string,
    pgHost: process.env['PG_HOST'] as string,
    pgPort: parseInt(process.env['PG_PORT'] ?? '5432', 10),
    pgDatabase: process.env['PG_DATABASE'] as string,
    pgUser: process.env['PG_USER'] as string,
    pgPassword: process.env['PG_PASSWORD'] as string,
    port: parseInt(process.env['PORT'] ?? '3001', 10),
    allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'https://nelsonlamounier.com,http://localhost:3000').split(',').map(s => s.trim()),
    bedrockApiKeySecretArn: process.env['BEDROCK_API_KEY_SECRET_ARN'] ?? undefined,
    bedrockPublicApiUrl: process.env['BEDROCK_PUBLIC_API_URL'] ?? undefined,
    bedrockAuthApiUrl: process.env['BEDROCK_AUTH_API_URL'] ?? undefined,
    githubAppSecretArn: process.env['GITHUB_APP_SECRET_ARN'] as string,
    portfolioOwnerUserId: process.env['PORTFOLIO_OWNER_USER_ID'],
    articleAssetsBucketName: process.env['ARTICLE_ASSETS_BUCKET_NAME'],
  });
}
