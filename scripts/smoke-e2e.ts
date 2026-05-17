/** @format */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ALL_FLOWS, type FlowName, type Endpoints, SmokeSetupError } from './smoke/types.js';
import {
  resolveChatbotUrls, resolveChatbotApiKey, resolveCognitoClientId,
  resolveRdsConn, resolveAuth,
} from './smoke/discovery.js';
import { COGNITO } from './smoke/admin-api-contract.js';
import { mintCognitoJwt } from './smoke/cognito-auth.js';
import { startPortForward } from './smoke/port-forward.js';
import { connectRds } from './smoke/rds-client.js';
import { readCleanupTargets } from './smoke/cleanup-file.js';

const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PROFILE = process.env.AWS_PROFILE ?? 'dev-account';
const NAME_PREFIX = process.env.SMOKE_NAME_PREFIX ?? 'bedrock-dev';

function parseArgs(argv: string[]): FlowName[] {
  const flows = argv.filter(a => !a.startsWith('-'));
  if (flows.length === 0 || flows.includes('all')) return [...ALL_FLOWS];
  for (const f of flows) if (!ALL_FLOWS.includes(f as FlowName)) {
    throw new Error(`unknown flow "${f}". valid: ${ALL_FLOWS.join(', ')}, all`);
  }
  return flows as FlowName[];
}

async function main() {
  process.env.AWS_PROFILE = PROFILE;
  const flows = parseArgs(process.argv.slice(2));
  const cleanFirst = process.argv.includes('--clean-first');
  const skipCleanup = process.env.SKIP_CLEANUP === '1';

  if (!COGNITO.username || !COGNITO.password) {
    throw new SmokeSetupError(
      'SMOKE_COGNITO_USERNAME / SMOKE_COGNITO_PASSWORD are required '
      + '(dedicated dev test user). Fill them in .env.smoke before the first run.');
  }

  const stops: Array<() => void> = [];
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-'));
  const epFile = join(tmp, 'endpoints.json');
  const cleanupFile = join(tmp, 'cleanup.jsonl');
  let failed = false;
  let testUserId = '';
  let rdsDatabase = '';

  try {
    const pgFwd = await startPortForward({ namespace: 'platform', target: 'svc/pgbouncer', localPort: 15432, remotePort: 5432 });
    stops.push(pgFwd.stop);
    const adminFwd = await startPortForward({ namespace: 'admin-api', target: 'svc/admin-api', localPort: 13002, remotePort: 3002 });
    stops.push(adminFwd.stop);

    const auth = resolveAuth(PROFILE);
    const cfg = { region: REGION, profile: PROFILE, credentials: auth.credentials };
    const [chat, chatbotApiKey, clientId, rds] = await Promise.all([
      resolveChatbotUrls(NAME_PREFIX, cfg),
      resolveChatbotApiKey(NAME_PREFIX, cfg),
      resolveCognitoClientId(),
      resolveRdsConn(),
    ]);

    // Mint the Cognito JWT once per run; the sub IS the test user id (the
    // server derives identity from the JWT, never from request bodies).
    const { idToken, sub } = await mintCognitoJwt({
      clientId,
      username: COGNITO.username,
      password: COGNITO.password,
      region: COGNITO.region,
    });
    testUserId = sub;
    rdsDatabase = rds.database;
    process.env.SMOKE_TEST_USER_ID = sub;
    console.log(`[smoke] flows=${flows.join(',')} user=${sub} db=${rds.database} profile=${PROFILE}`);

    const ep: Endpoints = {
      adminApiBaseUrl: 'http://127.0.0.1:13002',
      cognitoIdToken: idToken,
      cognitoSub: sub,
      ...chat,
      chatbotApiKey,
      pgPassword: rds.password, pgHost: '127.0.0.1', pgPort: 15432,
      pgDatabase: rds.database, pgUser: rds.user,
    };
    writeFileSync(epFile, JSON.stringify(ep));
    process.env.SMOKE_ENDPOINTS_FILE = epFile;
    process.env.SMOKE_CLEANUP_FILE = cleanupFile;

    if (cleanFirst) {
      const c = await connectRds({
        host: '127.0.0.1', port: 15432, database: rds.database,
        user: rds.user, password: rds.password, testUserId: sub,
      });
      await c.cleanupUserScoped();
      await c.close();
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
    if (!skipCleanup && testUserId && rdsDatabase) {
      try {
        let pw = '';
        try { pw = JSON.parse(readFileSync(epFile, 'utf-8')).pgPassword as string; } catch { pw = ''; }
        const targets = readCleanupTargets(cleanupFile);
        if (pw) {
          const rds = await connectRds({
            host: '127.0.0.1', port: 15432, database: rdsDatabase,
            user: JSON.parse(readFileSync(epFile, 'utf-8')).pgUser as string,
            password: pw, testUserId,
          });
          let userScopedNeeded = false;
          for (const t of targets) {
            if (t.pipelineRunId || t.applicationId || t.slug || t.importId || t.repoFullName) {
              await rds.cleanupRun(t);
            }
            if (t.chatSessionId) await rds.cleanupChatSession(t.chatSessionId);
            if (t.flow === 'ingestion' || t.flow === 'resume-import') userScopedNeeded = true;
          }
          // Safety net for tables a partial/failed run may have written
          // without recording a precise target — still TEST_USER scoped.
          if (userScopedNeeded) await rds.cleanupUserScoped();
          await rds.close();
        }
        const s3Keys = targets.flatMap(t => t.s3Keys);
        if (s3Keys.length > 0) {
          const bucket = process.env.SMOKE_ASSETS_BUCKET;
          if (bucket) {
            const s3 = new S3Client({ region: REGION });
            for (const Key of s3Keys) {
              await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(
                (e: unknown) => console.warn(`[smoke] s3 cleanup skip ${Key}: ${(e as Error).message}`));
            }
          }
        }
        console.log(`[smoke] cleanup done (${targets.length} targets)`);
      } catch (e) {
        console.warn(`[smoke] cleanup error (non-fatal): ${(e as Error).message}`);
      }
    } else if (skipCleanup) {
      console.log(`[smoke] SKIP_CLEANUP=1 — retained rows for ${testUserId}; endpoints: ${epFile}; cleanup-file: ${cleanupFile}`);
    }
    for (const stop of stops.reverse()) try { stop(); } catch { /* noop */ }
    if (!skipCleanup) rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? '[smoke] RESULT: FAIL' : '[smoke] RESULT: PASS');
  process.exit(failed ? 1 : 0);
}

void main();
