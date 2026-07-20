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
 *       await pushFinalMetrics(obs.registry, 'resume-import-processor', userId);
 *       await obs.shutdown();
 *   }
 *
 * The `instance` argument MUST be a *bounded, stable* key — a business
 * identifier that recurs across runs (userId, `userId_repo`, or a constant
 * like 'global' for singleton jobs). Pushgateway groups push state by URL
 * path (job + grouping labels) and **retains every distinct group in memory
 * forever**, so a per-run key (pipelineRunId, importId, `Date.now()`) leaks
 * one group per execution and eventually OOM-kills the gateway. A stable key
 * *replaces* the prior push rather than accumulating.
 *
 * This rule is enforced at merge time by `pushgateway-cardinality.test.ts`
 * (a source scan of every call site) and defensively at runtime below.
 */

import type { Registry } from 'prom-client';
import type { Logger as PinoLogger } from 'pino';

const PUSHGATEWAY_URL = process.env['PUSHGATEWAY_URL']
    ?? 'http://pushgateway.monitoring.svc.cluster.local:9091';

/**
 * Identifier names that are unique-per-run and MUST NOT be passed as the
 * Pushgateway `instance` key — the source-scan test fails the build if any
 * `pushFinalMetrics` call site references one of these. Kept here so the rule
 * lives next to the helper it protects.
 */
export const EPHEMERAL_INSTANCE_TOKENS: readonly string[] = [
    'pipelineRunId',
    'coachPipelineRunId',
    'importId',
    'runId',
    'correlationId',
    'traceId',
    'requestId',
    'Date.now',
    'randomUUID',
];

/** True if a runtime instance value looks like a per-run key (epoch-ms stamp). */
export function instanceKeyLooksEphemeral(instance: string): boolean {
    return instance.length === 0 || /\d{13}/.test(instance);
}

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
    // Lazy require so Lambda handlers importing the shared barrel do not need
    // prom-client in their runtime bundle. K8s jobs call this path explicitly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pushgateway } = require('prom-client') as typeof import('prom-client');
    const gateway = new Pushgateway(PUSHGATEWAY_URL, { timeout: 5000 }, registry);
    const logger = (globalThis as { __obsHandle?: { logger: PinoLogger } }).__obsHandle?.logger;
    // Defensive runtime guard: a per-run key leaks a Pushgateway group forever.
    // We never throw (observability must not break the Job) but make misuse loud
    // so it shows up in Loki even if it slips past the source-scan test.
    if (instanceKeyLooksEphemeral(instance)) {
        logger?.warn(
            { jobName, instance },
            'pushgateway instance key looks ephemeral (per-run) — this leaks a metric group every run and will OOM the gateway; use a bounded key (userId / "global")',
        );
    }
    try {
        await gateway.pushAdd({ jobName, groupings: { instance } });
    } catch (err) {
        // Best-effort — never crash the Job because Pushgateway is unhappy.
        // Route through the bootstrap logger so the failure lands in Loki at
        // error level (promtail picks it up). Without this, push failures look
        // identical to "the Job didn't run" in Grafana — see dashboard
        // `resume-import` panels backed by `resume_import_runs_total`.
        const log = (globalThis as {
            __obsHandle?: { logger: PinoLogger };
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
