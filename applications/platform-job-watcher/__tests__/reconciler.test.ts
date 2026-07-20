import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';
import type { WatcherEntry } from '../src/config.js';

const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 0 });
const mockPool = { query: queryMock } as unknown as Pool;

// Resume-import entry with the schema defaults loadConfig fills in.
const resumeEntry: WatcherEntry = {
  namespace:        'resume-import',
  dbTable:          'resume_imports',
  staleAfterMinutes: 15,
  statusColumn:     'status',
  staleColumn:      'started_at',
  errorColumn:      'error_code',
  completedColumn:  'completed_at',
  failedValue:      'failed',
  errorValue:       'WATCHER_TIMEOUT',
  terminalStatuses: ['completed', 'failed', 'awaiting_upload'],
  jobLabelKey:      'import-id',
};

// Ingestion entry mapped to the repo_sync_state schema.
const ingestionEntry: WatcherEntry = {
  namespace:        'ingestion',
  dbTable:          'repo_sync_state',
  staleAfterMinutes: 20,
  statusColumn:     'sync_status',
  staleColumn:      'last_sync_triggered_at',
  errorColumn:      'error_message',
  completedColumn:  'updated_at',
  failedValue:      'error',
  errorValue:       'Ingestion job did not complete in time. Please re-sync.',
  terminalStatuses: ['complete', 'error'],
  jobLabelKey:      'import-id',
};

describe('runReconciliation', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 0 });
  });

  it('sweeps resume_imports with its schema columns + values', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReconciliation(mockPool, [resumeEntry]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE resume_imports');
    expect(sql).toContain('status');
    expect(sql).toContain('started_at');
    // Values + window are parameterised, not inlined.
    expect(params).toEqual(['failed', 'WATCHER_TIMEOUT', ['completed', 'failed', 'awaiting_upload'], 15]);

    consoleSpy.mockRestore();
  });

  it('sweeps repo_sync_state with its own columns, terminal set, and window', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReconciliation(mockPool, [ingestionEntry]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE repo_sync_state');
    expect(sql).toContain('sync_status');
    expect(sql).toContain('last_sync_triggered_at');
    expect(sql).toContain('error_message');
    expect(params).toEqual(['error', 'Ingestion job did not complete in time. Please re-sync.', ['complete', 'error'], 20]);

    consoleSpy.mockRestore();
  });

  it('runs one UPDATE per entry when multiple watchers configured', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReconciliation(mockPool, [resumeEntry, ingestionEntry]);

    expect(queryMock).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('logs an error but does not throw when a query fails', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runReconciliation(mockPool, [resumeEntry])).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
