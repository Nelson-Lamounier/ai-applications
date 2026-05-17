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
      const stamp = Date.now();
      const slug = `smoke-article-${stamp}`;
      const s3Key = `smoke/article-${stamp}/draft.md`;
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: s3Key, Body: readFileSync(`${__dirname}/fixtures/article-draft.md`),
      }));

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.cognitoIdToken);
      const started = await api.startArticle({ s3Key, slug });
      const { pipelineRunId } = started;
      // Prefer the slug the admin-api echoes back; fall back to ours.
      const effectiveSlug = started.slug ?? slug;
      recordCleanup({ flow: 'article-pipeline', pipelineRunId, slug: effectiveSlug, s3Keys: [s3Key] });

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      const rows = await rds.assertRows(
        'SELECT status, content_md FROM articles WHERE slug = $1 AND author_id = $2',
        [effectiveSlug, TEST_USER_ID], 'articles row for the generated slug');
      const a = rows[0] as { status: string; content_md: string };
      expect(['review', 'published']).toContain(a.status);
      expect((a.content_md ?? '').length).toBeGreaterThan(0);
    } finally {
      await rds.close();
    }
  }, TIMEOUT + 60_000);
});
