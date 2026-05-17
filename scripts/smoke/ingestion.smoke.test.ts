/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const REPO = process.env.SMOKE_INGEST_REPO ?? 'sindresorhus/is';
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('ingestion e2e', () => {
  it('admin-api -> ingest -> document_embeddings', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startIngestion({ userId: TEST_USER_ID, repoFullName: REPO });
      console.log(`SMOKE_CLEANUP ingestion ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      await rds.assertRows(
        'SELECT 1 FROM document_embeddings WHERE user_id = $1 LIMIT 1', [TEST_USER_ID],
        'document_embeddings rows');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
