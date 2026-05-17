/** @format */
import { readFileSync } from 'node:fs';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
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
      const seed = await rds.assertRows(
        'SELECT id FROM resumes WHERE user_id = $1 LIMIT 1', [TEST_USER_ID],
        'a seed resume for the test user (run resume-import first or seed one)');
      const resumeId = (seed[0] as { id: string }).id;

      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.adminApiToken);
      const jd = readFileSync(`${__dirname}/fixtures/strategist-jd.txt`, 'utf-8');
      const { pipelineRunId } = await api.startStrategist({
        userId: TEST_USER_ID, targetCompany: 'Smoke Test Co',
        targetRole: 'Senior SRE', jobDescription: jd, resumeId,
      });
      console.log(`SMOKE_CLEANUP job-strategist ${pipelineRunId}`);

      const status = await rds.waitForPipelineStatus(pipelineRunId, TIMEOUT, 5000);
      expect(status).toBe('complete');

      await rds.assertRows(
        'SELECT 1 FROM job_applications WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'job_applications row');
      await rds.assertRows(
        "SELECT 1 FROM resumes WHERE user_id = $1 AND source = 'tailored' AND pipeline_run_id = $2",
        [TEST_USER_ID, pipelineRunId], 'tailored resume row');
      await rds.assertRows(
        'SELECT 1 FROM coaching_content WHERE user_id = $1 AND pipeline_run_id = $2',
        [TEST_USER_ID, pipelineRunId], 'coaching_content row');
    } finally {
      await rds.close();
    }
  }, Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000') + 60_000);
});
