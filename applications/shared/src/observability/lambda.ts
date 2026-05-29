/**
 * @format
 * Lambda observability helper for @bedrock/shared.
 *
 * Lambdas in this repo (chatbot, chatbot-public/-authenticated, self-healing
 * agent + tools) get observability through three signals:
 *
 *   - **Traces** via AWS-native X-Ray. Each Function sets `tracing: ACTIVE`
 *     (a CDK NodejsFunction prop), so the Lambda service creates a facade
 *     segment per invocation. This module adds a top-level subsegment per
 *     handler via {@link withSpan}; downstream AWS SDK calls become
 *     subsegments where handlers wrap their clients with
 *     `AWSXRay.captureAWSv3Client(...)`. No external ADOT/OTel layer — that
 *     dependency was removed (AWS deprecates managed layer versions, which
 *     repeatedly broke deploys with lambda:GetLayerVersion AccessDenied).
 *   - **Metrics** via CloudWatch EMF (shared/src/emf.ts) — layer-independent.
 *   - **Logs** via shared/src/logger.ts, enriched with the active X-Ray
 *     trace id (parsed from _X_AMZN_TRACE_ID) so log→trace pivots work.
 */

import * as AWSXRay from 'aws-xray-sdk-core';

import { xrayTraceContextFromEnv } from './xray-trace-id.js';

// Off-Lambda (unit tests, K8s workloads) there is no X-Ray context. Log
// instead of throwing so getSegment() never blows up a handler or a test.
AWSXRay.setContextMissingStrategy('LOG_ERROR');

/**
 * Active X-Ray trace + parent-segment ids, parsed from the `_X_AMZN_TRACE_ID`
 * env var Lambda populates per invocation
 * (`Root=1-...;Parent=<id>;Sampled=1`). Returns `{}` when no X-Ray context is
 * present (local / K8s / cold path). Shape matches what the logger consumes,
 * so Grafana can pivot Logs → Traces on `trace_id`.
 */
export function activeTraceContext(): { trace_id?: string; span_id?: string } {
    return xrayTraceContextFromEnv();
}

/**
 * Wrap an AWS SDK v3 client so its calls appear as X-Ray subsegments
 * (downstream traces for Bedrock / DynamoDB / S3 / etc.). No-op-safe: if the
 * X-Ray SDK can't wrap (or off-Lambda), the original client is returned.
 * Call at client construction in Lambda handlers.
 */
export function captureAwsClient<T extends object>(client: T): T {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- X-Ray types the arg loosely; the wrapped client keeps T's shape.
        return AWSXRay.captureAWSv3Client(client as any) as T;
    } catch {
        return client;
    }
}

/**
 * Wraps a Lambda handler so every invocation opens a top-level X-Ray
 * subsegment named after the function. When no X-Ray segment is in scope
 * (tests / non-Lambda) it runs the handler unwrapped — never throws.
 *
 * Variadic so it adapts to API Gateway handlers (single event arg) and
 * Lambda's standard `(event, context)` signature without separate types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSpan<F extends (...args: any[]) => Promise<any>>(
    spanName: string,
    handler: F,
): F {
    const wrapped = ((...args: Parameters<F>) => {
        let segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined;
        try {
            segment = AWSXRay.getSegment();
        } catch {
            segment = undefined;
        }
        if (!segment) return handler(...args);

        const sub = segment.addNewSubsegment(spanName);
        return (async () => {
            try {
                const result = await handler(...args);
                sub.close();
                return result;
            } catch (err) {
                sub.close(err instanceof Error ? err : new Error(String(err)));
                throw err;
            }
        })();
    }) as F;
    return wrapped;
}
