import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 1 });
const mockPool = { query: queryMock } as unknown as Pool;

describe('markJobFailed', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 1 });
  });

  it('updates the correct table with JOB_FAILED and the import-id from labels', async () => {
    const { markJobFailed } = await import('../src/mark-job-failed.js');

    await markJobFailed(mockPool, 'resume_imports', 'abc-123-uuid');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('resume_imports');
    expect(sql).toContain('JOB_FAILED');
    expect(params[0]).toBe('abc-123-uuid');
  });

  it('logs a warning when no rows were updated (import already terminal)', async () => {
    const { markJobFailed } = await import('../src/mark-job-failed.js');
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await markJobFailed(mockPool, 'resume_imports', 'abc-123-uuid');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[watcher]'),
      expect.objectContaining({ importId: 'abc-123-uuid' }),
    );
    warnSpy.mockRestore();
  });

  it('does not throw when the importId is missing from job labels', async () => {
    const { markJobFailed } = await import('../src/mark-job-failed.js');

    await expect(markJobFailed(mockPool, 'resume_imports', undefined)).resolves.not.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
