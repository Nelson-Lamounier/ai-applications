/** @format */
import { readFileSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import { recordCleanup } from './cleanup-file.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const BUCKET = process.env.SMOKE_ASSETS_BUCKET!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('article-pipeline e2e', () => {
  it('admin-api -> pipeline -> articles row', async () => {
    if (!process.env.SMOKE_ASSETS_BUCKET) { console.warn('[smoke] SMOKE_ASSETS_BUCKET unset — skipping'); return; }
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const s3Key = `smoke/article-${Date.now()}/draft.md`;
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: s3Key, Body: readFileSync(`${__dirname}/fixtures/article-draft.md`),
      }));

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startArticle({ userId: TEST_USER_ID, s3Key });
      recordCleanup({ flow: 'article-pipeline', pipelineRunId, s3Keys: [s3Key] });

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      const rows = await rds.assertRows(
        'SELECT status FROM articles WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'articles row');
      expect(['review', 'published']).toContain((rows[0] as { status: string }).status);
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
