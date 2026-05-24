import * as k8s         from '@kubernetes/client-node';
import type { Pool }    from 'pg';
import type { WatcherEntry } from './config.js';

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

export function watchNamespace(
  kc:    k8s.KubeConfig,
  pool:  Pool,
  entry: WatcherEntry,
): () => void {
  let stopped = false;

  async function startWatch(): Promise<void> {
    if (stopped) return;
    const watch = new k8s.Watch(kc);

    try {
      await watch.watch(
        `/apis/batch/v1/namespaces/${entry.namespace}/jobs`,
        {},
        async (type, job: k8s.V1Job) => {
          if (type !== 'MODIFIED') return;
          const failed = job.status?.failed ?? 0;
          if (failed === 0) return;

          // Event-driven fast path is keyed on the `import-id` label + an
          // `id`/`status`/`error_code` schema (resume_imports). Tables without
          // an `import-id` label (e.g. repo_sync_state ingestion Jobs) no-op
          // here and are reconciled by the generalized stale sweep instead;
          // for those, admin-api also reconciles at read time.
          const importId = job.metadata?.labels?.['import-id'];
          await markJobFailed(pool, entry.dbTable, importId).catch((err) =>
            console.error('[watcher] markJobFailed threw', { err, importId }),
          );
        },
        (err) => {
          if (stopped) return;
          if (err) console.warn('[watcher] stream closed with error — reconnecting', { namespace: entry.namespace, err });
          else      console.info('[watcher] stream closed — reconnecting', { namespace: entry.namespace });
          setTimeout(() => void startWatch(), 5_000);
        },
      );
    } catch (err) {
      if (stopped) return;
      console.error('[watcher] failed to open watch stream — retrying in 10s', { namespace: entry.namespace, err });
      setTimeout(() => void startWatch(), 10_000);
    }
  }

  void startWatch();

  return () => { stopped = true; };
}
