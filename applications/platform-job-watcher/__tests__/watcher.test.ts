import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';
import type { WatcherEntry } from '../src/config.js';

const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 1 });
const mockPool = { query: queryMock } as unknown as Pool;

// resume_imports schema, no linked reconcile.
const resumeEntry: WatcherEntry = {
  namespace: 'resume-import', dbTable: 'resume_imports', staleAfterMinutes: 15,
  statusColumn: 'status', staleColumn: 'started_at', errorColumn: 'error_code',
  completedColumn: 'completed_at', failedValue: 'failed', errorValue: 'WATCHER_TIMEOUT',
  terminalStatuses: ['completed', 'failed', 'awaiting_upload'], jobLabelKey: 'import-id',
};

// pipeline_runs schema WITH a linked job_applications.kanban_status reconcile.
const strategistEntry: WatcherEntry = {
  namespace: 'job-strategist', dbTable: 'pipeline_runs', staleAfterMinutes: 30,
  statusColumn: 'status', staleColumn: 'created_at', errorColumn: 'error_message',
  completedColumn: 'updated_at', failedValue: 'failed', errorValue: 'interrupted',
  terminalStatuses: ['complete', 'failed'], jobLabelKey: 'pipeline-run-id',
  linkedTable: 'job_applications', linkedVia: 'reference_id',
  linkedStatusColumn: 'kanban_status', linkedFromValue: 'analysing', linkedToValue: 'failed',
};

describe('markJobFailed', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 1 });
  });

  it('is schema-aware: uses the entry columns/values (no hard-coded error_code)', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    await markJobFailed(mockPool, resumeEntry, 'abc-123-uuid');

    expect(queryMock).toHaveBeenCalledTimes(1); // no linked reconcile for this entry
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('resume_imports');
    expect(sql).toContain('status');
    expect(sql).toContain('error_code');       // this entry's errorColumn
    expect(sql).not.toContain('JOB_FAILED');   // no longer hard-coded
    expect(params).toEqual(['failed', 'WATCHER_TIMEOUT', 'abc-123-uuid', ['completed', 'failed', 'awaiting_upload']]);
  });

  it('uses pipeline_runs columns for the strategist entry (error_message/updated_at)', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    await markJobFailed(mockPool, strategistEntry, 'run-1');

    const [primarySql, primaryParams] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(primarySql).toContain('pipeline_runs');
    expect(primarySql).toContain('error_message');
    expect(primarySql).toContain('updated_at');
    expect(primaryParams[2]).toBe('run-1');
  });

  it('also reconciles the linked job_applications.kanban_status (scoped to the run)', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    await markJobFailed(mockPool, strategistEntry, 'run-1');

    expect(queryMock).toHaveBeenCalledTimes(2); // primary + linked
    const [linkedSql, linkedParams] = queryMock.mock.calls[1] as unknown as [string, unknown[]];
    expect(linkedSql).toContain('job_applications');
    expect(linkedSql).toContain('kanban_status');
    expect(linkedSql).toContain('reference_id');
    expect(linkedSql).toContain('MAX(');             // latest-sibling guard
    expect(linkedSql).toContain('AND d.id = $4');    // scoped to this run
    expect(linkedParams).toEqual(['failed', 'analysing', 'failed', 'run-1']);
  });

  it('logs a warning when no rows were updated (import already terminal)', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await markJobFailed(mockPool, resumeEntry, 'abc-123-uuid');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[watcher]'),
      expect.objectContaining({ importId: 'abc-123-uuid' }),
    );
    warnSpy.mockRestore();
  });

  it('does not throw or query when the importId is missing from job labels', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    await expect(markJobFailed(mockPool, resumeEntry, undefined)).resolves.not.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('reconcileLinkedStatus', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 1 });
  });

  it('no-ops when the entry has no linked table', async () => {
    const { reconcileLinkedStatus } = await import('../src/watcher.js');
    await reconcileLinkedStatus(mockPool, resumeEntry);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('runs a set-based reconcile (no scope) when called without a primaryId', async () => {
    const { reconcileLinkedStatus } = await import('../src/watcher.js');
    await reconcileLinkedStatus(mockPool, strategistEntry);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('job_applications');
    expect(sql).not.toContain('AND d.id = $4'); // set-based: no run scope
    expect(params).toEqual(['failed', 'analysing', 'failed']);
  });
});
