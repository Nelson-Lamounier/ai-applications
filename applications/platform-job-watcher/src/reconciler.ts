import type { Pool } from 'pg';
import type { WatcherEntry } from './config.js';

export async function runReconciliation(
  pool: Pool,
  watchers: readonly WatcherEntry[],
): Promise<void> {
  for (const entry of watchers) {
    try {
      const result = await pool.query(
        `UPDATE ${entry.dbTable}
            SET status       = 'failed',
                error_code   = 'WATCHER_TIMEOUT',
                completed_at = NOW()
          WHERE status NOT IN ('completed', 'failed', 'awaiting_upload')
            AND started_at < NOW() - ($1 || ' minutes')::INTERVAL`,
        [entry.staleAfterMinutes],
      );
      const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
      if (affected > 0) {
        console.info('[reconciler] marked stale imports as failed', {
          table: entry.dbTable,
          count: affected,
        });
      }
    } catch (err) {
      console.error('[reconciler] sweep failed', {
        table: entry.dbTable,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}
