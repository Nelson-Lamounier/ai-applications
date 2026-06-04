import type { Pool } from 'pg';

export async function markJobFailed(
  pool:     Pool,
  dbTable:  string,
  importId: string | undefined,
): Promise<void> {
  if (!importId) return;

  const result = await pool.query(
    `UPDATE ${dbTable}
        SET status       = 'failed',
            error_code   = 'JOB_FAILED',
            completed_at = NOW()
      WHERE id = $1::uuid
        AND status NOT IN ('completed', 'failed')`,
    [importId],
  );
  const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
  if (affected === 0) {
    console.warn('[watcher] markJobFailed: no rows updated (already terminal?)', { importId });
  } else {
    console.info('[watcher] marked import as JOB_FAILED', { importId, table: dbTable });
  }
}
