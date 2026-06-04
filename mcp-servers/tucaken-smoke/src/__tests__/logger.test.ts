/** @format */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLogs, redact } from '../logger.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smokelog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pruneLogs', () => {
  it('keeps newest N, deletes the rest', () => {
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `smoke-${String(i).padStart(3,'0')}.log`), 'x');
    pruneLogs(dir, 20);
    const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort();
    expect(files.length).toBe(20);
    expect(files[0]).toBe('smoke-005.log');
  });
});

describe('redact', () => {
  it('masks secrets by key', () => {
    const out = redact({ password: 'p', idToken: 'jwt', body: { ok: 1 } }) as Record<string, unknown>;
    expect(out.password).toBe('***');
    expect(out.idToken).toBe('***');
    expect((out.body as { ok: number }).ok).toBe(1);
  });
});
