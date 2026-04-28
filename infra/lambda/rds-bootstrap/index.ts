/**
 * @format
 * RDS pgvector Schema Bootstrap — Custom Resource Handler
 *
 * Runs DDL against a fresh RDS PostgreSQL instance at CloudFormation CREATE
 * and UPDATE time. All statements use IF NOT EXISTS — safe to re-run.
 *
 * Must be placed inside the VPC (isolated subnet) to reach RDS via TCP.
 * Fetches credentials from Secrets Manager via an interface VPC endpoint.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import { Client } from 'pg';

interface RdsSecret {
    username: string;
    password: string;
}

/** DDL executed in order at bootstrap. Each string is one statement. */
function buildDdl(embeddingDimension: number): string[] {
    return [
        // Step 1 — pgvector extension
        'CREATE EXTENSION IF NOT EXISTS vector;',

        // Step 2 — document_embeddings table (chunk-level, repo-scoped)
        `CREATE TABLE IF NOT EXISTS document_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  heading         TEXT,
  content         TEXT        NOT NULL,
  content_tsv     TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_type       TEXT,
  tags            TEXT[],
  chunk_index     INTEGER     NOT NULL,
  total_chunks    INTEGER     NOT NULL,
  content_hash    TEXT        NOT NULL,
  embedding       vector(${embeddingDimension}) NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,

        // Step 3 — repo_sync_state table
        `CREATE TABLE IF NOT EXISTS repo_sync_state (
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  sync_status     TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at  TIMESTAMPTZ,
  file_count      INTEGER     NOT NULL DEFAULT 0,
  chunk_count     INTEGER     NOT NULL DEFAULT 0,
  error_message   TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);`,

        // Step 4 — b-tree on user_id
        'CREATE INDEX IF NOT EXISTS idx_embeddings_user_id ON document_embeddings (user_id);',

        // Step 5 — composite b-tree on (user_id, repo_full_name)
        'CREATE INDEX IF NOT EXISTS idx_embeddings_user_repo ON document_embeddings (user_id, repo_full_name);',

        // Step 6 — unique natural key index for ON CONFLICT upserts
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_natural_key
  ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);`,

        // Step 7 — HNSW index for approximate nearest-neighbour search
        // m=16, ef_construction=64 are pgvector defaults — tune after data load
        `CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
  ON document_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);`,

        // Step 8 — Backfill content_tsv on tables created before this column was added.
        // The ADD COLUMN IF NOT EXISTS is a no-op on fresh deployments (column already
        // declared in CREATE TABLE). On existing instances it adds and populates the column.
        `ALTER TABLE document_embeddings
    ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;`,

        // Step 9 — GIN index for BM25 full-text search (hybrid retrieval)
        `CREATE INDEX IF NOT EXISTS idx_embeddings_content_tsv
  ON document_embeddings USING gin (content_tsv);`,
    ];
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
    const physicalId = 'rds-pgvector-schema-bootstrap';

    if (event.RequestType === 'Delete') {
        return { PhysicalResourceId: physicalId };
    }

    const secretArn        = process.env.SECRET_ARN!;
    const host             = process.env.RDS_HOST!;
    const port             = parseInt(process.env.RDS_PORT!, 10);
    const database         = process.env.RDS_DB_NAME!;
    const embeddingDim     = parseInt(process.env.EMBEDDING_DIMENSION!, 10);

    const sm = new SecretsManagerClient({});
    const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const { username, password } = JSON.parse(SecretString!) as RdsSecret;

    const client = new Client({
        host,
        port,
        database,
        user: username,
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10_000,
    });

    await client.connect();

    try {
        for (const sql of buildDdl(embeddingDim)) {
            await client.query(sql);
        }
    } finally {
        await client.end();
    }

    return { PhysicalResourceId: physicalId };
}
