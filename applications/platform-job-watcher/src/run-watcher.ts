import * as k8s from '@kubernetes/client-node';
import { bootstrapK8sObservability } from '@bedrock/shared';
import { Counter } from 'prom-client';
import { loadConfig, loadDbConfig } from './config.js';
import { getPool, closePool }       from './db.js';
import { watchNamespace }           from './watcher.js';
import { runReconciliation }        from './reconciler.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

// Bootstrap OTel + pino + prom-client + (optional) Pyroscope as soon as
// the module loads — instrumentations must register before pg / k8s
// clients are first used to be picked up by auto-instrumentation.
const obs = bootstrapK8sObservability({ serviceName: 'platform-job-watcher' });
const log = obs.logger;

// Domain metrics — incremented from watcher / reconciler callbacks.
// Exposed on /metrics by obs.startMetricsServer() below.
export const jobEventsTotal = new Counter({
  name:       'platform_job_watcher_events_total',
  help:       'Kubernetes Job lifecycle events processed by the watcher.',
  labelNames: ['namespace', 'event_type', 'phase'] as const,
  registers:  [obs.registry],
});

export const reconcileRunsTotal = new Counter({
  name:       'platform_job_watcher_reconcile_runs_total',
  help:       'Reconciliation passes attempted, by outcome.',
  labelNames: ['outcome'] as const,
  registers:  [obs.registry],
});

async function main(): Promise<void> {
  const config   = loadConfig();
  const dbConfig = loadDbConfig();
  const pool     = getPool(dbConfig);

  await pool.query('SELECT 1');
  log.info('DB connection OK');

  // Long-running service — expose /metrics + /livez + /readyz on 9100.
  obs.startMetricsServer(9100);

  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();

  const stopFns: Array<() => void> = [];

  for (const entry of config.watchers) {
    log.info({ namespace: entry.namespace, table: entry.dbTable }, 'starting watch');
    const stop = watchNamespace(kc, pool, entry);
    stopFns.push(stop);
  }

  async function reconcile(): Promise<void> {
    try {
      await runReconciliation(pool, config.watchers);
      reconcileRunsTotal.inc({ outcome: 'ok' });
    } catch (err) {
      reconcileRunsTotal.inc({ outcome: 'error' });
      log.error({ err }, 'reconciliation pass failed');
    }
  }
  await reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

  async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, 'shutting down');
    clearInterval(reconcileTimer);
    stopFns.forEach((fn) => fn());
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await closePool();
    await obs.shutdown();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  log.info({
    watchers: config.watchers.map((w) => w.namespace),
    reconcileIntervalMin: RECONCILE_INTERVAL_MS / 60_000,
  }, 'running');
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
