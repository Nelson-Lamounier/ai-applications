/** @format */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCleanup, readCleanupTargets } from '../cleanup-file';

describe('cleanup-file', () => {
  let dir: string; let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-')); file = join(dir, 'cleanup.jsonl'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('recordCleanup is a no-op when SMOKE_CLEANUP_FILE is unset', () => {
    delete process.env.SMOKE_CLEANUP_FILE;
    expect(() => recordCleanup({ flow: 'ingestion', pipelineRunId: 'r1' })).not.toThrow();
  });

  it('appends one JSON line per record and reads them back', () => {
    process.env.SMOKE_CLEANUP_FILE = file;
    try {
      recordCleanup({ flow: 'article-pipeline', pipelineRunId: 'r1', s3Keys: ['smoke/r1/a.md'] });
      recordCleanup({ flow: 'chatbots', chatSessionId: 's-9' });
      const targets = readCleanupTargets(file);
      expect(targets).toEqual([
        { flow: 'article-pipeline', pipelineRunId: 'r1', s3Keys: ['smoke/r1/a.md'], chatSessionId: undefined },
        { flow: 'chatbots', pipelineRunId: undefined, s3Keys: [], chatSessionId: 's-9' },
      ]);
    } finally { delete process.env.SMOKE_CLEANUP_FILE; }
  });

  it('readCleanupTargets returns [] for a missing file', () => {
    expect(readCleanupTargets(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});
