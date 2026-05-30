/**
 * @format
 * Bedrock invocation metrics — bridge from extractTokenUsage() / Converse
 * responses to Prometheus counters that flow through Pushgateway (K8s
 * pipelines) or sit unused on Lambdas (which still rely on EMF).
 *
 * Why both EMF and Prometheus? Different consumers:
 *   - **EMF** is push-only into CloudWatch Metrics — works in Lambda, free,
 *     queryable from Grafana via the CloudWatch data source. We keep it.
 *   - **Prometheus** is pull/push-based, queryable in PromQL with the same
 *     labels as `http_requests_total` and friends — joins cleanly in dashboards
 *     ("$/req for routes that called Bedrock"). For K8s Jobs we already have
 *     Pushgateway plumbing; emitting one more counter is free.
 *
 * Three counters land:
 *   - bedrock_tokens_total{model, kind, service, route}    cumulative tokens
 *   - bedrock_calls_total{model, service, route, outcome}  one per Converse
 *   - bedrock_cost_usd_total{model, service, route}        estimated USD
 *
 * Routing wiring:
 *   K8s pipelines call setBedrockMetricsRegistry(handle.registry) inside
 *   bootstrapK8sObservability so the counters live on the bootstrap registry
 *   and get pushed to Pushgateway on Job exit.
 *   Lambdas don't call it; counters register against prom-client's default
 *   global registry — present but unscaped, no harm.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import type { Counter, Registry } from 'prom-client';

interface Counters {
    tokensTotal: Counter<string>;
    callsTotal:  Counter<string>;
    costUsd:     Counter<string>;
}

let _counters: Counters | undefined;
let _activeRegistry: Registry | undefined;

/**
 * Bind the bedrock counters to a specific registry. Called from
 * bootstrapK8sObservability so the metrics flow into Pushgateway on exit.
 * Must run before the first recordBedrockUsage() — bootstrap-time is fine.
 */
export function setBedrockMetricsRegistry(registry: Registry): void {
    _activeRegistry = registry;
    // Force re-registration so a swap mid-process surfaces on the new reg.
    _counters = undefined;
}

function ensureCounters(): Counters {
    if (_counters) return _counters;

    const prom = require('prom-client') as typeof import('prom-client'); // eslint-disable-line @typescript-eslint/consistent-type-imports -- typeof import() needed for require's module-shape cast
    const registry = _activeRegistry ?? prom.register;

    _counters = {
        tokensTotal: new prom.Counter({
            name: 'bedrock_tokens_total',
            help: 'Bedrock token usage. kind ∈ {input, output, thinking, cache_read, cache_write}.',
            labelNames: ['model', 'kind', 'service', 'route'] as const,
            registers: [registry],
        }),
        callsTotal: new prom.Counter({
            name: 'bedrock_calls_total',
            help: 'Bedrock Converse / InvokeModel calls.',
            labelNames: ['model', 'service', 'route', 'outcome'] as const,
            registers: [registry],
        }),
        costUsd: new prom.Counter({
            name: 'bedrock_cost_usd_total',
            help: 'Estimated Bedrock invocation cost in USD.',
            labelNames: ['model', 'service', 'route'] as const,
            registers: [registry],
        }),
    };
    return _counters;
}

export interface BedrockUsage {
    inputTokens:           number;
    outputTokens:          number;
    thinkingTokens?:       number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
}

export interface RecordBedrockUsageArgs {
    /** Foundation model ID (e.g. anthropic.claude-sonnet-4-6). */
    model:     string;
    /** Calling workload — 'article-pipeline', 'chatbot', etc. */
    service:   string;
    /** Logical operation — 'research', 'writer', 'qa', 'embed'. Keep low cardinality. */
    route:     string;
    /** Token counts as returned by Converse usage. */
    usage:     BedrockUsage;
    /** Pre-computed cost in USD (use estimateInvocationCost). */
    costUsd?:  number;
    /** Mostly 'success' — emit 'failed' from a catch block when retries exhaust. */
    outcome?:  'success' | 'failed';
}

/**
 * Increment the three Bedrock counters from one Converse / InvokeModel
 * response. Safe to call from any code path; failures are swallowed so
 * a metrics hiccup never breaks a pipeline run.
 */
export function recordBedrockUsage(args: RecordBedrockUsageArgs): void {
    try {
        const c       = ensureCounters();
        const labels  = { model: args.model, service: args.service, route: args.route };
        const outcome = args.outcome ?? 'success';

        c.callsTotal.inc({ ...labels, outcome });
        c.tokensTotal.inc({ ...labels, kind: 'input'  }, args.usage.inputTokens);
        c.tokensTotal.inc({ ...labels, kind: 'output' }, args.usage.outputTokens);
        if (args.usage.thinkingTokens) {
            c.tokensTotal.inc({ ...labels, kind: 'thinking' }, args.usage.thinkingTokens);
        }
        if (args.usage.cacheReadInputTokens) {
            c.tokensTotal.inc({ ...labels, kind: 'cache_read' }, args.usage.cacheReadInputTokens);
        }
        if (args.usage.cacheWriteInputTokens) {
            c.tokensTotal.inc({ ...labels, kind: 'cache_write' }, args.usage.cacheWriteInputTokens);
        }
        if (args.costUsd) {
            c.costUsd.inc(labels, args.costUsd);
        }
    } catch {
        // prom-client unavailable, registry not set up, etc. — never crash
        // the calling pipeline because of an observability concern.
    }
}
