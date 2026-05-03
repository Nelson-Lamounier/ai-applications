import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 0 });
const mockPool = { query: queryMock } as unknown as Pool;

describe('runReconciliation', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 0 });
  });

  it('runs one UPDATE per watcher entry and logs the row count', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import', dbTable: 'resume_imports', staleAfterMinutes: 15 },
    ];

    await runReconciliation(mockPool, watchers);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('resume_imports');
    expect(sql).toContain('WATCHER_TIMEOUT');
    expect(params[0]).toBe(15);

    consoleSpy.mockRestore();
  });

  it('runs one UPDATE per entry when multiple watchers configured', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import',  dbTable: 'resume_imports',  staleAfterMinutes: 15 },
      { namespace: 'ingestion',       dbTable: 'ingestion_jobs',  staleAfterMinutes: 30 },
    ];

    await runReconciliation(mockPool, watchers);

    expect(queryMock).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('logs an error but does not throw when a query fails', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import', dbTable: 'resume_imports', staleAfterMinutes: 15 },
    ];

    await expect(runReconciliation(mockPool, watchers)).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
