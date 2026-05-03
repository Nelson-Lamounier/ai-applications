import * as k8s from '@kubernetes/client-node';
import { loadConfig, loadDbConfig } from './config.js';
import { getPool, closePool }       from './db.js';
import { watchNamespace }           from './watcher.js';
import { runReconciliation }        from './reconciler.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

async function main(): Promise<void> {
  const config   = loadConfig();
  const dbConfig = loadDbConfig();
  const pool     = getPool(dbConfig);

  await pool.query('SELECT 1');
  console.info('[run-watcher] DB connection OK');

  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();

  const stopFns: Array<() => void> = [];

  for (const entry of config.watchers) {
    console.info('[run-watcher] starting watch', { namespace: entry.namespace, table: entry.dbTable });
    const stop = watchNamespace(kc, pool, entry);
    stopFns.push(stop);
  }

  async function reconcile(): Promise<void> {
    await runReconciliation(pool, config.watchers);
  }
  await reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

  async function shutdown(signal: string): Promise<void> {
    console.info('[run-watcher] shutting down', { signal });
    clearInterval(reconcileTimer);
    stopFns.forEach((fn) => fn());
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await closePool();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  console.info('[run-watcher] running', {
    watchers: config.watchers.map((w) => w.namespace),
    reconcileIntervalMin: RECONCILE_INTERVAL_MS / 60_000,
  });
}

main().catch((err) => {
  console.error('[run-watcher] fatal startup error', err);
  process.exit(1);
});
