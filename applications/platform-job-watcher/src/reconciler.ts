import type { Pool } from 'pg';
import type { WatcherEntry } from './config.js';
import { reconcileLinkedStatus } from './watcher.js';

export async function runReconciliation(
  pool: Pool,
  watchers: readonly WatcherEntry[],
): Promise<void> {
  for (const entry of watchers) {
    try {
      // Column names come from validated config identifiers (loadConfig →
      // validateIdentifier), never from request input — safe to interpolate.
      // Values + the stale window are parameterised.
      const result = await pool.query(
        `UPDATE ${entry.dbTable}
            SET ${entry.statusColumn}    = $1,
                ${entry.errorColumn}     = $2,
                ${entry.completedColumn} = NOW()
          WHERE NOT (${entry.statusColumn} = ANY($3::text[]))
            AND ${entry.staleColumn} < NOW() - ($4 || ' minutes')::INTERVAL`,
        [entry.failedValue, entry.errorValue, entry.terminalStatuses, entry.staleAfterMinutes],
      );
      const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
      if (affected > 0) {
        console.info('[reconciler] marked stale imports as failed', {
          table: entry.dbTable,
          count: affected,
        });
      }
      // Reconcile any denormalised linked status (e.g. job_applications.kanban_status)
      // for rows this sweep — or an earlier event/sweep — left failed. Set-based
      // (no primaryId): fixes every stuck linked row whose latest run has failed.
      await reconcileLinkedStatus(pool, entry);
    } catch (err) {
      console.error('[reconciler] sweep failed', {
        table: entry.dbTable,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}
