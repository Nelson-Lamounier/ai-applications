/** @format */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectRds } from './rds-client.js';
import { AdminApiClient } from './admin-api-client.js';
import { recordCleanup } from './cleanup-file.js';
import type { Endpoints } from './types.js';

const ep: Endpoints = JSON.parse(readFileSync(process.env.SMOKE_ENDPOINTS_FILE!, 'utf-8'));
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID!;
const TIMEOUT = Number(process.env.SMOKE_FLOW_TIMEOUT ?? '600000');
const PDF = resolve(__dirname, '../../applications/resume-import-processor/src/parsers/__tests__/fixtures/Nelson_Lamounier_Resume.pdf');

describe('resume-import e2e', () => {
  it('admin-api 3-step upload -> import -> user_career_history', async () => {
    if (!existsSync(PDF)) { console.warn('[smoke] resume PDF fixture missing — skipping'); return; }
    const rds = await connectRds({
      host: ep.pgHost, port: ep.pgPort, database: ep.pgDatabase,
      user: ep.pgUser, password: ep.pgPassword, testUserId: TEST_USER_ID,
    });
    try {
      const bytes = readFileSync(PDF);
      const contentType = 'application/pdf';
      const api = new AdminApiClient(ep.adminApiBaseUrl, ep.cognitoIdToken);

      // Step 1: presigned PUT ticket. Step 2: raw PUT (Content-Type +
      // Content-Length must match what was signed). Step 3: complete.
      const ticket = await api.requestResumeUpload({
        filename: 'Nelson_Lamounier_Resume.pdf',
        contentType,
        fileSizeBytes: statSync(PDF).size,
      });
      recordCleanup({ flow: 'resume-import', importId: ticket.importId, s3Keys: [ticket.s3Key] });
      await api.putResumeBytes(ticket.uploadUrl, bytes, contentType);
      await api.completeResumeImport(ticket.importId);

      const status = await rds.waitForImportStatus(ticket.importId, TIMEOUT, 5000);
      expect(status).toBe('completed');
      await rds.assertRows(
        'SELECT 1 FROM user_career_history WHERE user_id = $1 AND import_id = $2 LIMIT 1',
        [TEST_USER_ID, ticket.importId], 'user_career_history rows for the import');
    } finally {
      await rds.close();
    }
  }, TIMEOUT + 60_000);
});
