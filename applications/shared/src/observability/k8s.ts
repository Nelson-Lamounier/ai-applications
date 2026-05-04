/**
 * @format
 * Shared observability bootstrap for K8s workloads in @bedrock/shared.
 *
 * Used by:
 *   - applications/platform-job-watcher  (long-running Deployment)
 *   - applications/resume-import-processor (one-shot K8s Job)
 *   - applications/platform-rds-bootstrap  (one-shot init Job)
 *
 * Wires four pillars with one call. Long-running services should also
 * call `startMetricsServer()` so Prometheus can scrape `/metrics`.
 * Batch jobs should call `pushAndShutdown()` instead — see pushgateway.ts.
 *
 * Importing this module pulls native bindings (Pyroscope's pprof). To keep
 * test/build environments hermetic, the SDK is only initialised when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (and PYROSCOPE_SERVER_ADDRESS) are set —
 * unset env => pure no-op so unit tests stay fast.
 *
 * NB: this module imports OpenTelemetry instrumentations that monkey-patch
 * Node core modules. For full coverage in ESM apps, also use
 * `node --import` to load the bootstrap before the entrypoint. The K8s
 * apps under applications/ are CommonJS, so a simple `import` at the top
 * of the entrypoint is sufficient (require-time hooks fire correctly).
 */

import http from 'node:http';

let bootstrapped = false;

export interface ObservabilityHandle {
    /** Pino-compatible structured logger with active span context mixin. */
    readonly logger: import('pino').Logger;
    /** prom-client default registry (or namespaced). */
    readonly registry: import('prom-client').Registry;
    /** Stop OTel + flush spans + close metrics server. Call on SIGTERM. */
    shutdown(): Promise<void>;
    /** Bind a /metrics HTTP server (long-running services only). */
    startMetricsServer(port?: number): http.Server;
}

export interface BootstrapOptions {
    serviceName:        string;
    /** Defaults to chart appVersion / git sha via env. */
    serviceVersion?:    string;
    /** development | staging | production. */
    deployEnv?:         string;
    /** info|debug|warn|error. */
    logLevel?:          string;
}

/**
 * Bootstrap OpenTelemetry + prom-client + pino + (optional) Pyroscope.
 * Idempotent — repeat calls return the already-built handle.
 */
export function bootstrapK8sObservability(opts: BootstrapOptions): ObservabilityHandle {
    if (bootstrapped) {
        // The handle from the first call is stored on globalThis so a second
        // import (e.g. from a test util) returns the same instance.
        return (globalThis as { __obsHandle?: ObservabilityHandle }).__obsHandle!;
    }
    bootstrapped = true;

    // Lazy require so non-K8s consumers (e.g. Lambdas) don't pay the load.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NodeSDK }                  = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter }        = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { resourceFromAttributes }   = require('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
    const { context, trace }           = require('@opentelemetry/api');
    const pino                         = require('pino');
    const prom                         = require('prom-client');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const serviceName    = opts.serviceName;
    const serviceVersion = opts.serviceVersion ?? process.env['OTEL_SERVICE_VERSION'] ?? '0.0.0';
    const deployEnv      = opts.deployEnv      ?? process.env['DEPLOY_ENV']             ?? 'dev';
    const logLevel       = opts.logLevel       ?? process.env['LOG_LEVEL']
        ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');

    // ── OTel ────────────────────────────────────────────────────────────────
    const sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]:    serviceName,
            [ATTR_SERVICE_VERSION]: serviceVersion,
        }),
        traceExporter: new OTLPTraceExporter({}),
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-fs':  { enabled: false },
            }),
        ],
    });
    if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
        sdk.start();
    }

    // ── Pyroscope (optional) ───────────────────────────────────────────────
    if (process.env['PYROSCOPE_SERVER_ADDRESS']) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Pyroscope = require('@pyroscope/nodejs');
        Pyroscope.init({
            serverAddress: process.env['PYROSCOPE_SERVER_ADDRESS'],
            appName:       serviceName,
            tags: { env: deployEnv, version: serviceVersion },
        });
        Pyroscope.start();
    }

    // ── Logger ─────────────────────────────────────────────────────────────
    const logger = pino({
        level:    logLevel,
        base:     { service: serviceName, env: deployEnv },
        mixin() {
            const span = trace.getSpan(context.active());
            if (!span) return {};
            const { traceId, spanId, traceFlags } = span.spanContext();
            return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
        },
        formatters: { level: (l: string) => ({ level: l }) },
        timestamp:  pino.stdTimeFunctions.isoTime,
        redact: {
            paths: ['*.password', '*.token', '*.apiKey', '*.authorization'],
            censor: '[REDACTED]',
        },
    });

    // ── Metrics ────────────────────────────────────────────────────────────
    const registry = new prom.Registry();
    registry.setDefaultLabels({ service: serviceName, env: deployEnv });
    prom.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

    let metricsServer: http.Server | undefined;

    const handle: ObservabilityHandle = {
        logger,
        registry,
        startMetricsServer(port = 9100) {
            if (metricsServer) return metricsServer;
            metricsServer = http.createServer(async (req, res) => {
                if (req.url === '/metrics') {
                    const body = await registry.metrics();
                    res.writeHead(200, { 'Content-Type': registry.contentType });
                    res.end(body);
                    return;
                }
                if (req.url === '/livez' || req.url === '/readyz') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"status":"ok"}');
                    return;
                }
                res.writeHead(404);
                res.end();
            });
            metricsServer.listen(port, () => {
                logger.info({ port }, 'metrics server listening');
            });
            return metricsServer;
        },
        async shutdown() {
            try { await sdk.shutdown(); } catch { /* best effort */ }
            if (metricsServer) await new Promise<void>((r) => metricsServer!.close(() => r()));
        },
    };

    // Bind Bedrock metrics to the bootstrap registry so any subsequent
    // `recordBedrockUsage()` call lands on the same registry that gets
    // pushed to Pushgateway on Job exit.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setBedrockMetricsRegistry } = require('./bedrock');
    setBedrockMetricsRegistry(registry);

    (globalThis as { __obsHandle?: ObservabilityHandle }).__obsHandle = handle;

    process.once('SIGTERM', () => handle.shutdown().then(() => process.exit(0)));
    process.once('SIGINT',  () => handle.shutdown().then(() => process.exit(0)));

    return handle;
}
