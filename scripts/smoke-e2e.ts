/** @format */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ALL_FLOWS, type FlowName, type Endpoints } from './smoke/types.js';
import { resolveChatbotUrls, resolveAdminSecrets, resolvePgPassword, resolveAuth } from './smoke/discovery.js';
import { startPortForward } from './smoke/port-forward.js';
import { connectRds } from './smoke/rds-client.js';

const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PROFILE = process.env.AWS_PROFILE ?? 'dev-account';
const NAME_PREFIX = process.env.SMOKE_NAME_PREFIX ?? 'bedrock-data-development';
const TEST_USER_ID = process.env.SMOKE_TEST_USER_ID ?? '31f4686a-979b-4765-a17c-22a1e71cec59';
const PG_DATABASE = process.env.SMOKE_PG_DATABASE ?? 'tucaken';
const PG_USER = process.env.SMOKE_PG_USER ?? 'postgres';

function parseArgs(argv: string[]): FlowName[] {
  const flows = argv.filter(a => !a.startsWith('-'));
  if (flows.length === 0 || flows.includes('all')) return [...ALL_FLOWS];
  for (const f of flows) if (!ALL_FLOWS.includes(f as FlowName)) {
    throw new Error(`unknown flow "${f}". valid: ${ALL_FLOWS.join(', ')}, all`);
  }
  return flows as FlowName[];
}

async function main() {
  process.env.SMOKE_TEST_USER_ID = TEST_USER_ID;
  process.env.AWS_PROFILE = PROFILE;
  const flows = parseArgs(process.argv.slice(2));
  const cleanFirst = process.argv.includes('--clean-first');
  const skipCleanup = process.env.SKIP_CLEANUP === '1';
  console.log(`[smoke] flows=${flows.join(',')} user=${TEST_USER_ID} profile=${PROFILE}`);

  const stops: Array<() => void> = [];
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-'));
  const epFile = join(tmp, 'endpoints.json');
  let failed = false;

  try {
    const pgFwd = await startPortForward({ namespace: 'platform', target: 'svc/pgbouncer', localPort: 15432, remotePort: 5432 });
    stops.push(pgFwd.stop);
    const adminFwd = await startPortForward({ namespace: 'admin-api', target: 'svc/admin-api', localPort: 13002, remotePort: 3002 });
    stops.push(adminFwd.stop);

    const auth = resolveAuth(PROFILE);
    const cfg = { region: REGION, profile: PROFILE, credentials: auth.credentials };
    const [chat, secrets, pgPassword] = await Promise.all([
      resolveChatbotUrls(NAME_PREFIX, cfg),
      resolveAdminSecrets(),
      resolvePgPassword(),
    ]);
    const ep: Endpoints = {
      adminApiBaseUrl: 'http://127.0.0.1:13002',
      adminApiToken: secrets.adminApiToken,
      chatbotAuthJwt: secrets.chatbotAuthJwt,
      ...chat,
      pgPassword, pgHost: '127.0.0.1', pgPort: 15432,
      pgDatabase: PG_DATABASE, pgUser: PG_USER,
    };
    writeFileSync(epFile, JSON.stringify(ep));
    process.env.SMOKE_ENDPOINTS_FILE = epFile;

    if (cleanFirst) {
      const rds = await connectRds({
        host: '127.0.0.1', port: 15432, database: PG_DATABASE,
        user: PG_USER, password: pgPassword, testUserId: TEST_USER_ID,
      });
      await rds.cleanupUserScoped();
      await rds.close();
      console.log('[smoke] pre-clean done');
    }

    const patterns = flows.map(f => `${f}.smoke.test.ts`).join('|');
    const res = spawnSync('node_modules/.bin/jest', [
      '--config', 'scripts/smoke/jest.smoke.config.cjs',
      '--runInBand', '--testPathPattern', patterns,
    ], { stdio: 'inherit', env: process.env });
    failed = res.status !== 0;
  } catch (e) {
    failed = true;
    console.error(`[smoke] SETUP FAILED: ${(e as Error).message}`);
  } finally {
    if (!skipCleanup) {
      try {
        let pw = '';
        try { pw = JSON.parse(readFileSync(epFile, 'utf-8')).pgPassword as string; } catch { pw = ''; }
        if (pw) {
          const rds = await connectRds({
            host: '127.0.0.1', port: 15432, database: PG_DATABASE,
            user: PG_USER, password: pw, testUserId: TEST_USER_ID,
          });
          await rds.cleanupRun({ flow: 'job-strategist', s3Keys: [] });
          await rds.cleanupUserScoped();
          await rds.close();
        }
        const s3 = new S3Client({ region: REGION });
        void s3; void DeleteObjectCommand;
        console.log('[smoke] cleanup done');
      } catch (e) {
        console.warn(`[smoke] cleanup error (non-fatal): ${(e as Error).message}`);
      }
    } else {
      console.log(`[smoke] SKIP_CLEANUP=1 — retained rows for ${TEST_USER_ID}; endpoints: ${epFile}`);
    }
    for (const stop of stops.reverse()) try { stop(); } catch { /* noop */ }
    if (!skipCleanup) rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? '[smoke] RESULT: FAIL' : '[smoke] RESULT: PASS');
  process.exit(failed ? 1 : 0);
}

void main();
