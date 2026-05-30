/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import { recordCleanup } from './cleanup-file.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const REPO = process.env.SMOKE_INGEST_REPO ?? 'sindresorhus/is';
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('ingestion e2e', () => {
  it('admin-api -> ingest -> repo_sync_state + document_embeddings', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.cognitoIdToken);
      const { pipelineRunId } = await api.startIngestion({ repoFullName: REPO });
      recordCleanup({ flow: 'ingestion', pipelineRunId, repoFullName: REPO });

      // Ingestion progress is tracked on repo_sync_state (user_id + repo),
      // not pipeline_runs — OK 'complete', FAIL 'error'.
      const status = await rds.waitForRepoSync(REPO, TIMEOUT, 5000);
      expect(status).toBe('complete');
      await rds.assertRows(
        'SELECT 1 FROM document_embeddings WHERE user_id = $1 AND repo_full_name = $2 LIMIT 1',
        [TEST_USER_ID, REPO], 'document_embeddings rows for the repo');
    } finally {
      await rds.close();
    }
  }, TIMEOUT + 60_000);
});
