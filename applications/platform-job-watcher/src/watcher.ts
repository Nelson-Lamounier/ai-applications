import * as k8s         from '@kubernetes/client-node';
import type { Pool }    from 'pg';
import type { WatcherEntry } from './config.js';

export async function markJobFailed(
  pool:     Pool,
  entry:    WatcherEntry,
  importId: string | undefined,
): Promise<void> {
  if (!importId) return;

  // Schema-aware: use the entry's configured status/error/completed columns and
  // terminal set (identifiers validated in loadConfig, values parameterised) so
  // the event fast path works for every table — not just the resume_imports
  // schema. Previously this hard-coded status/error_code/completed_at, which
  // threw for pipeline_runs (error_message/updated_at) and silently dropped
  // strategist failures onto the 30-min stale sweep.
  const result = await pool.query(
    `UPDATE ${entry.dbTable}
        SET ${entry.statusColumn}    = $1,
            ${entry.errorColumn}     = $2,
            ${entry.completedColumn} = NOW()
      WHERE id = $3::uuid
        AND NOT (${entry.statusColumn} = ANY($4::text[]))`,
    [entry.failedValue, entry.errorValue, importId, entry.terminalStatuses],
  );
  const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
  if (affected === 0) {
    console.warn('[watcher] markJobFailed: no rows updated (already terminal?)', { importId, table: entry.dbTable });
  } else {
    console.info('[watcher] marked failed via event', { importId, table: entry.dbTable });
  }

  // Reconcile the denormalised linked status (e.g. job_applications.kanban_status)
  // regardless of the primary rowcount — the run may already be failed (stale
  // sweep) while its linked row is still stuck 'analysing'.
  await reconcileLinkedStatus(pool, entry, importId).catch((err) =>
    console.error('[watcher] reconcileLinkedStatus threw', {
      err: err instanceof Error ? err.message : String(err), table: entry.dbTable,
    }),
  );
}

/**
 * When a primary row is failed, also fail the denormalised-status row it links
 * to (pipeline_runs.reference_id -> job_applications.id) if that row is still in
 * `linkedFromValue`. The MAX-sibling guard means only the LATEST run for the
 * linked entity drives the transition, so an in-flight re-run is never
 * clobbered. No-op unless the entry configures a linked table. `primaryId`
 * scopes the event path to one run; the stale sweep passes none (set-based).
 */
export async function reconcileLinkedStatus(
  pool:      Pool,
  entry:     WatcherEntry,
  primaryId?: string,
): Promise<void> {
  if (!entry.linkedTable) return;
  const scoped = primaryId ? ` AND d.id = $4::uuid` : '';
  const params: unknown[] = [entry.linkedToValue, entry.linkedFromValue, entry.failedValue];
  if (primaryId) params.push(primaryId);

  const result = await pool.query(
    `UPDATE ${entry.linkedTable} lt
        SET ${entry.linkedStatusColumn} = $1
       FROM ${entry.dbTable} d
      WHERE lt.id = d.${entry.linkedVia}::uuid
        AND lt.${entry.linkedStatusColumn} = $2
        AND d.${entry.statusColumn} = $3
        AND d.${entry.staleColumn} = (
              SELECT MAX(d2.${entry.staleColumn})
                FROM ${entry.dbTable} d2
               WHERE d2.${entry.linkedVia} = d.${entry.linkedVia})${scoped}`,
    params,
  );
  const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
  if (affected > 0) {
    console.info('[watcher] reconciled linked status', { linkedTable: entry.linkedTable, rows: affected });
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

          // Event-driven fast path is keyed on this entry's `jobLabelKey` label
          // (default `import-id` for resume_imports; `pipeline-run-id` for the
          // job-strategist/pipeline_runs entry) whose VALUE is the dbTable row id.
          // Jobs without that label no-op here and are reconciled by the
          // generalized stale sweep instead; for some, admin-api also reconciles
          // at read time.
          const importId = job.metadata?.labels?.[entry.jobLabelKey];
          await markJobFailed(pool, entry, importId).catch((err) =>
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
