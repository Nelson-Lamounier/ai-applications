/**
 * @format
 * Pushgateway helper for short-lived K8s Jobs.
 *
 * Jobs die before Prometheus's 30s scrape interval. They push their final
 * counters/histograms to the in-cluster Pushgateway service before exit;
 * Prometheus scrapes Pushgateway as a regular target and the metrics
 * appear with the {service, instance} group key carrying the Job UUID.
 *
 * Usage from a Job's main():
 *
 *   const obs = bootstrapK8sObservability({ serviceName: 'resume-import-processor' });
 *   try {
 *       // ... do work, increment counters on obs.registry ...
 *   } finally {
 *       await pushFinalMetrics(obs.registry, 'resume-import-processor', importId);
 *       await obs.shutdown();
 *   }
 *
 * The `instance` argument should be a stable per-run identifier (importId,
 * job UUID, request ID) — Pushgateway groups push state by URL path
 * (job + grouping labels), so reusing instance across runs *replaces*
 * rather than aggregates.
 */

import { Pushgateway, type Registry } from 'prom-client';

const PUSHGATEWAY_URL = process.env['PUSHGATEWAY_URL']
    ?? 'http://pushgateway.monitoring.svc.cluster.local:9091';

/**
 * Push every metric in `registry` to Pushgateway under {job=<jobName>,
 * instance=<instance>}, replacing any prior push for that pair.
 *
 * Errors are caught + logged: a Pushgateway failure must NEVER mask the
 * Job's actual exit status. The Job already wrote its primary outcome to
 * Postgres / S3; metrics are observability, not the source of truth.
 */
export async function pushFinalMetrics(
    registry: Registry,
    jobName:  string,
    instance: string,
): Promise<void> {
    const gateway = new Pushgateway(PUSHGATEWAY_URL, { timeout: 5000 }, registry);
    try {
        await gateway.pushAdd({ jobName, groupings: { instance } });
    } catch (err) {
        // Best-effort — never crash the Job because Pushgateway is unhappy.
        // Route through the bootstrap logger so the failure lands in Loki at
        // error level (promtail picks it up). Without this, push failures look
        // identical to "the Job didn't run" in Grafana — see dashboard
        // `resume-import` panels backed by `resume_import_runs_total`.
        const log = (globalThis as {
            __obsHandle?: { logger: import('pino').Logger };
        }).__obsHandle?.logger;
        const payload = {
            err:         (err as Error).message,
            jobName,
            instance,
            pushgateway: PUSHGATEWAY_URL,
        };
        if (log) {
            log.error(payload, 'pushgateway push failed — metrics for this run will be missing');
        } else {
             
            console.error('[obs] pushgateway failed', payload);
        }
    }
}
