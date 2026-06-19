import {
    context,
    trace,
    SpanStatusCode,
    type Attributes,
    type Context,
    type Span,
} from '@opentelemetry/api';

import { xrayTraceContextFromEnv } from './xray-trace-id.js';

export interface WorkflowTrace {
    readonly traceId: string;
    readonly rootSpan: Span;
    setAttributes(attributes: Attributes): void;
    stage<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T>;
}

export function currentTraceContext(): { traceId?: string; spanId?: string } {
    const active = trace.getSpan(context.active());
    if (active) {
        const ids = active.spanContext();
        if (ids.traceId) {
            return {
                traceId: ids.traceId,
                spanId: ids.spanId,
            };
        }
    }

    const xray = xrayTraceContextFromEnv();
    return {
        traceId: xray.trace_id,
        spanId: xray.span_id,
    };
}

export async function withWorkflowTrace<T>(
    options: { name: string; parentContext: Context; attributes: Attributes },
    work: (workflow: WorkflowTrace) => Promise<T>,
): Promise<{ result: T; traceId: string }> {
    const tracer = trace.getTracer('@bedrock/shared-project-workflows');
    const rootSpan = tracer.startSpan(
        options.name,
        { attributes: options.attributes },
        options.parentContext,
    );
    const traceId = rootSpan.spanContext().traceId;
    const activeContext = trace.setSpan(options.parentContext, rootSpan);
    const workflow: WorkflowTrace = {
        traceId,
        rootSpan,
        setAttributes: (attributes) => rootSpan.setAttributes(attributes),
        stage: async (name, attributes, stageWork) =>
            tracer.startActiveSpan(name, { attributes }, activeContext, async (span) => {
                try {
                    return await stageWork();
                } catch (error) {
                    const exception = error instanceof Error ? error : new Error(String(error));
                    span.recordException(exception);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
                    throw error;
                } finally {
                    span.end();
                }
            }),
    };

    try {
        const result = await context.with(activeContext, () => work(workflow));
        rootSpan.setStatus({ code: SpanStatusCode.OK });
        return { result, traceId };
    } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        rootSpan.recordException(exception);
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw error;
    } finally {
        rootSpan.end();
    }
}
