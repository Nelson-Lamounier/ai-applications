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
      recordCleanup({ flow: 'article-pipeline', pipelineRunId: 'r1', slug: 'p1', s3Keys: ['smoke/r1/a.md'] });
      recordCleanup({ flow: 'job-strategist', pipelineRunId: 'r2', applicationId: 'app-2' });
      recordCleanup({ flow: 'resume-import', importId: 'imp-3', s3Keys: ['smoke/r3/r.pdf'] });
      recordCleanup({ flow: 'ingestion', repoFullName: 'o/r' });
      recordCleanup({ flow: 'chatbots', chatSessionId: 's-9' });
      const targets = readCleanupTargets(file);
      expect(targets).toEqual([
        { flow: 'article-pipeline', pipelineRunId: 'r1', slug: 'p1', applicationId: undefined, importId: undefined, repoFullName: undefined, s3Keys: ['smoke/r1/a.md'], chatSessionId: undefined },
        { flow: 'job-strategist', pipelineRunId: 'r2', slug: undefined, applicationId: 'app-2', importId: undefined, repoFullName: undefined, s3Keys: [], chatSessionId: undefined },
        { flow: 'resume-import', pipelineRunId: undefined, slug: undefined, applicationId: undefined, importId: 'imp-3', repoFullName: undefined, s3Keys: ['smoke/r3/r.pdf'], chatSessionId: undefined },
        { flow: 'ingestion', pipelineRunId: undefined, slug: undefined, applicationId: undefined, importId: undefined, repoFullName: 'o/r', s3Keys: [], chatSessionId: undefined },
        { flow: 'chatbots', pipelineRunId: undefined, slug: undefined, applicationId: undefined, importId: undefined, repoFullName: undefined, s3Keys: [], chatSessionId: 's-9' },
      ]);
    } finally { delete process.env.SMOKE_CLEANUP_FILE; }
  });

  it('readCleanupTargets returns [] for a missing file', () => {
    expect(readCleanupTargets(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});
