/** @format */
import { readFileSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const BUCKET = process.env.SMOKE_ASSETS_BUCKET!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');
const PDF = `${__dirname}/../../applications/resume-import-processor/src/parsers/__tests__/fixtures/Nelson_Lamounier_Resume.pdf`;

describe('resume-import e2e', () => {
  it('admin-api -> import -> user_career_history', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const s3Key = `smoke/resume-${Date.now()}/resume.pdf`;
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: readFileSync(PDF) }));
      console.log(`SMOKE_CLEANUP_S3 ${BUCKET} ${s3Key}`);

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const { pipelineRunId } = await api.startImport({ userId: TEST_USER_ID, s3Key });
      console.log(`SMOKE_CLEANUP resume-import ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');
      await rds.assertRows(
        'SELECT 1 FROM user_career_history WHERE user_id = $1', [TEST_USER_ID],
        'user_career_history rows');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
