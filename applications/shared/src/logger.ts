/**
 * @format
 * Shared Structured Logger
 *
 * Provides a consistent structured JSON logging interface for all
 * Bedrock agents. Each log entry includes `level`, `timestamp`,
 * and any additional structured data for CloudWatch Logs Insights
 * filterability.
 *
 * Two usage patterns are supported:
 *
 * 1. **Module-level `log()` function** — simple, stateless logger
 *    for handlers that don't need persistent context.
 *
 * 2. **`createLogger()` factory** — returns a logger pre-bound with
 *    default fields (e.g. `correlationId`), useful for agents like
 *    self-healing where every log must carry a correlation ID.
 *
 * @example
 * ```typescript
 * // Pattern 1: Simple stateless logger
 * import { log } from '@bedrock/shared';
 * log('INFO', 'Agent invoked', { sessionId, promptLength: 42 });
 *
 * // Pattern 2: Logger with persistent defaults
 * import { createLogger } from '@bedrock/shared';
 * const log = createLogger({ correlationId: 'abc-123' });
 * log('INFO', 'Processing event');  // correlationId auto-included
 * ```
 */

import { xrayTraceContextFromEnv } from './observability/xray-trace-id.js';

// =============================================================================
// TRACE CONTEXT MERGE
// =============================================================================
// Returns the active trace_id/span_id. K8s: from the OpenTelemetry span set
// by the observability bootstrap. Lambda: from the X-Ray _X_AMZN_TRACE_ID env
// (no @opentelemetry/api / X-Ray-SDK dep). Empty when neither is present, so
// logs work for any consumer that imports just the logger.
function activeTraceContextSafe(): { trace_id?: string; span_id?: string } {
    // K8s path: an OpenTelemetry span set by the observability bootstrap.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports -- lazy require with module-shape cast
        const otel = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
        const span = otel.trace.getSpan(otel.context.active());
        if (span) {
            const { traceId, spanId } = span.spanContext();
            return { trace_id: traceId, span_id: spanId };
        }
    } catch {
        // @opentelemetry/api not installed / no provider — fall through.
    }
    // Lambda path: X-Ray trace id from the per-invocation env var. Shared
    // pure-parse helper (no X-Ray dep) keeps the logger import-light.
    return xrayTraceContextFromEnv();
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Supported log severity levels.
 *
 * - `INFO`  — Normal operational events
 * - `WARN`  — Recoverable issues or degraded behaviour
 * - `ERROR` — Failed operations requiring attention
 */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Function signature for a structured logger.
 *
 * @param level - Log severity level
 * @param message - Human-readable description of the event
 * @param data - Optional structured key-value pairs for Logs Insights queries
 */
export type LogFunction = (
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
) => void;

// =============================================================================
// LOGGER FACTORY
// =============================================================================

/**
 * Create a structured logger pre-bound with default fields.
 *
 * Every log entry produced by the returned function will include
 * the `defaults` fields merged with any per-call `data`. This is
 * ideal for agents that need persistent context (e.g. `correlationId`)
 * across multiple log calls within a single invocation.
 *
 * @param defaults - Key-value pairs to include in every log entry
 * @returns A {@link LogFunction} that merges defaults with per-call data
 *
 * @example
 * ```typescript
 * const log = createLogger({ correlationId: 'req-42', agentName: 'self-healing' });
 * log('INFO', 'Tool invoked', { toolName: 'diagnose_alarm' });
 * // Output: {"level":"INFO","message":"Tool invoked","correlationId":"req-42","agentName":"self-healing","toolName":"diagnose_alarm","timestamp":"..."}
 * ```
 */
export function createLogger(defaults: Record<string, unknown>): LogFunction {
    return (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
        const entry = {
            level,
            message,
            ...defaults,
            ...activeTraceContextSafe(),
            ...data,
            timestamp: new Date().toISOString(),
        };

        if (level === 'ERROR') {
            console.error(JSON.stringify(entry));
        } else {
            console.log(JSON.stringify(entry));
        }
    };
}

// =============================================================================
// MODULE-LEVEL LOGGER
// =============================================================================

/**
 * Emit a structured JSON log line to CloudWatch Logs.
 *
 * Stateless convenience function for handlers that don't need
 * persistent context. Each call produces a single JSON line with
 * `level`, `message`, `timestamp`, and any additional `data` fields.
 *
 * ERROR-level messages are routed through `console.error()` so they
 * appear in CloudWatch Logs with the correct severity indicator.
 *
 * @param level - Log severity level
 * @param message - Human-readable description of the event
 * @param data - Optional structured key-value pairs
 *
 * @example
 * ```typescript
 * log('INFO', 'Agent invocation completed', {
 *     sessionId: '550e8400-...',
 *     durationMs: 1234,
 *     outputRedacted: true,
 * });
 * ```
 */
export function log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
): void {
    const entry = {
        level,
        message,
        timestamp: new Date().toISOString(),
        ...activeTraceContextSafe(),
        ...data,
    };

    if (level === 'ERROR') {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}
