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
  const watch  = new k8s.Watch(kc);

  async function startWatch(): Promise<void> {
    if (stopped) return;

    try {
      await watch.watch(
        `/apis/batch/v1/namespaces/${entry.namespace}/jobs`,
        {},
        async (type, job: k8s.V1Job) => {
          if (type !== 'MODIFIED') return;
          const failed = job.status?.failed ?? 0;
          if (failed === 0) return;

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
