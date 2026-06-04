/** @format */
import { DEV_TARGET } from './config.js';

export function assertDevTarget(t: { account: string; region: string; db: string }): void {
  if (t.account !== DEV_TARGET.account) throw new Error(`refusing: account ${t.account} != dev ${DEV_TARGET.account}`);
  if (t.region !== DEV_TARGET.region) throw new Error(`refusing: region ${t.region} != ${DEV_TARGET.region}`);
  if (t.db !== DEV_TARGET.db) throw new Error(`refusing: db ${t.db} != ${DEV_TARGET.db}`);
}

/** True only for a single read-only statement (SELECT or WITH…SELECT, no extra ';'). */
export function isSelectOnly(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false;
  return /^(select|with)\b/i.test(trimmed);
}
