/** @format */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = /^(password|pass|token|idtoken|accesstoken|secret|authorization|jwt)$/i;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '***' : redact(val);
    return o;
  }
  return v;
}

/** Delete oldest *.log beyond `retain` (lexical sort == chronological for our timestamped names). */
export function pruneLogs(dir: string, retain: number): void {
  if (!existsSync(dir)) return;
  const logs = readdirSync(dir).filter(f => f.endsWith('.log')).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - retain))) unlinkSync(join(dir, f));
}

export class SessionLogger {
  private readonly file: string;
  constructor(logsDir: string, isoStamp: string) {
    mkdirSync(logsDir, { recursive: true });
    this.file = join(logsDir, `smoke-${isoStamp.replace(/[:.]/g, '-')}.log`);
  }
  log(entry: Record<string, unknown>): void {
    appendFileSync(this.file, JSON.stringify({ ...redact(entry) as object }) + '\n');
  }
}

/** Default logs dir relative to the built file: <pkg>/logs. */
export function defaultLogsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
}
