/** @format */
import { SmokeSetupError } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard-aborts (no DB work) unless the resolved database is an allowed dev
 *  database AND the test user id is a UUID. The single most important guard
 *  in the harness — a cleanup bug here would delete real rows.
 *  The allowlist is read per-call (not frozen at module load) and uses `||`
 *  + `.filter(Boolean)` so an empty/blank SMOKE_ALLOWED_DBS fails closed. */
export function assertSafeToMutate(database: string, testUserId: string): void {
  const allowed = (process.env.SMOKE_ALLOWED_DBS || 'tucaken')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!allowed.includes(database)) {
    throw new SmokeSetupError(
      `Refusing to touch database "${database}" — not in allowed dev set [${allowed.join(', ')}]`,
    );
  }
  if (!testUserId || !UUID_RE.test(testUserId)) {
    throw new SmokeSetupError(
      `Refusing to run: test user id "${testUserId}" is empty or not a UUID`,
    );
  }
}
