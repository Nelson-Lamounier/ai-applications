/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import { recordCleanup } from './cleanup-file.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');

describe('job-strategist e2e', () => {
  it('admin-api -> pipeline -> RDS', async () => {
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      // resumeId is optional in the admin-api contract — pass an existing
      // seed resume if the test user has one, otherwise omit it.
      const seed = await rds.maybeRows(
        'SELECT id FROM resumes WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1', [TEST_USER_ID]);
      const resumeId = (seed[0] as { id: string } | undefined)?.id;

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.cognitoIdToken);
      const jd = readFileSync(`${__dirname}/fixtures/strategist-jd.txt`, 'utf-8');
      const { pipelineRunId, applicationId } = await api.startStrategist({
        targetCompany: 'Smoke Test Co', targetRole: 'Senior SRE',
        jobDescription: jd, ...(resumeId ? { resumeId } : {}),
      });
      recordCleanup({ flow: 'job-strategist', pipelineRunId, applicationId });

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');

      // The admin-api may return the application id directly; fall back to
      // the newest application for the test user if it does not.
      const apps = await rds.assertRows(
        'SELECT id FROM job_applications WHERE user_id = $1'
          + ' AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at DESC LIMIT 1',
        [TEST_USER_ID, applicationId ?? null], 'job_applications row');
      const appId = (apps[0] as { id: string }).id;
      await rds.assertRows(
        'SELECT 1 FROM resumes WHERE user_id = $1 AND job_application_id = $2',
        [TEST_USER_ID, appId], 'tailored resume row linked to the application');
      await rds.assertRows(
        'SELECT 1 FROM coaching_content WHERE job_application_id = $1',
        [appId], 'coaching_content row for the application');
    } finally {
      await rds.close();
    }
  }, TIMEOUT + 60_000);
});
