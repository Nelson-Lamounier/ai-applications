/** @format */
import { SmokeSetupError } from './types.js';

const ALLOWED_DBS = (process.env.SMOKE_ALLOWED_DBS ?? 'tucaken').split(',').map(s => s.trim());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard-aborts (no DB work) unless the resolved database is an allowed dev
 *  database AND the test user id is a UUID. The single most important guard
 *  in the harness — a cleanup bug here would delete real rows. */
export function assertSafeToMutate(database: string, testUserId: string): void {
  if (!ALLOWED_DBS.includes(database)) {
    throw new SmokeSetupError(
      `Refusing to touch database "${database}" — not in allowed dev set [${ALLOWED_DBS.join(', ')}]`,
    );
  }
  if (!testUserId || !UUID_RE.test(testUserId)) {
    throw new SmokeSetupError(
      `Refusing to run: test user id "${testUserId}" is empty or not a UUID`,
    );
  }
}
