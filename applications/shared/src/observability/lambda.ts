/**
 * @format
 * Lambda observability helper for @bedrock/shared.
 *
 * Lambdas in this repo (ingestion, chatbot, self-healing, job-strategist,
 * article-pipeline) get observability through three signals:
 *
 *   - **Traces** via the AWS-managed ADOT layer (added at Function-level
 *     via env vars; this module relies on that being attached). Span
 *     context is auto-propagated; user code can read it via @opentelemetry/api.
 *   - **Metrics** via CloudWatch EMF (already wired in shared/src/emf.ts).
 *     Lambda is a push-via-EMF environment — there's no Prometheus scrape.
 *     EMF is then forwarded via the existing CloudWatch metric stream into
 *     Grafana via the CloudWatch datasource — no separate ingestion path.
 *   - **Logs** via the existing structured logger in shared/src/logger.ts,
 *     which emits to CloudWatch Logs. This module enriches log calls with
 *     the active OTel `trace_id` so log-to-trace pivots in Grafana work.
 *
 * If you're invoking a Lambda from a Step Function or another Lambda and
 * want the trace to continue, make sure ADOT is configured on every link
 * in the chain. The ADOT layer config is owned by the CDK stack, not here.
 */

import { context, trace } from '@opentelemetry/api';

/**
 * Returns the active OTel span's IDs if a span is in scope, else empty.
 * Use this to enrich every log line so Grafana can pivot Logs → Traces.
 */
export function activeTraceContext(): { trace_id?: string; span_id?: string } {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
}

/**
 * Wraps a Lambda handler so every invocation creates a top-level span
 * named after the function. Useful when ADOT auto-instrumentation didn't
 * pick up the entrypoint (e.g. ESM, custom signature) — and harmless when
 * it did, because nested spans collapse cleanly in Tempo.
 *
 * Variadic so it adapts to API Gateway handlers (single event arg) and
 * Lambda's standard `(event, context)` signature without separate types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSpan<F extends (...args: any[]) => Promise<any>>(
    spanName: string,
    handler: F,
): F {
    const tracer = trace.getTracer('@bedrock/shared');
    const wrapped = ((...args: Parameters<F>) =>
        tracer.startActiveSpan(spanName, async (span) => {
            try {
                const result = await handler(...args);
                span.setStatus({ code: 1 });   // OK
                return result;
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: 2, message: (err as Error).message });
                throw err;
            } finally {
                span.end();
            }
        })) as F;
    return wrapped;
}
