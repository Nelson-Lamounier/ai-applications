/** @format */
/**
 * OpenTelemetry GenAI semantic-convention span recording for Bedrock agent
 * invocations.
 *
 * One span per model invocation, recorded post-hoc with explicit timestamps
 * (the agent runner already owns the call lifecycle; a wrapper would only
 * duplicate its error handling). Attribute names follow the OTel GenAI
 * semantic conventions (`gen_ai.*`) so future tooling (Tempo TraceQL,
 * Grafana GenAI panels) understands them without translation; platform-
 * specific extras live under the `tucaken.*` namespace.
 *
 * On Lambdas (no OTel SDK registered) `trace.getTracer` returns a no-op
 * tracer, so this is safe to call unconditionally.
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('@bedrock/shared-agent-runner');

export interface GenAiInvocationSpan {
    readonly agentName: string;
    readonly modelId: string;
    readonly pipeline: string;
    /** Epoch millis when the model call started/ended. */
    readonly startTimeMs: number;
    readonly endTimeMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens?: number;
    readonly costUsd?: number;
    readonly stopReason?: string;
    /** SHA-256 of the system prompt — answers "did the prompt change or the data?". */
    readonly systemPromptHash?: string;
    readonly promptVersion?: string;
    readonly error?: string;
}

/** Record one `chat {model}` span carrying GenAI semconv attributes. */
export function recordGenAiInvocationSpan(s: GenAiInvocationSpan): void {
    const span = tracer.startSpan(`chat ${s.modelId}`, { startTime: s.startTimeMs });
    span.setAttributes({
        'gen_ai.operation.name':      'chat',
        'gen_ai.system':              'aws.bedrock',
        'gen_ai.request.model':       s.modelId,
        'gen_ai.usage.input_tokens':  s.inputTokens,
        'gen_ai.usage.output_tokens': s.outputTokens,
        'tucaken.agent.name':         s.agentName,
        'tucaken.pipeline':           s.pipeline,
    });
    if (s.stopReason) span.setAttribute('gen_ai.response.finish_reasons', [s.stopReason]);
    if (typeof s.cacheReadInputTokens === 'number') span.setAttribute('gen_ai.usage.cache_read_input_tokens', s.cacheReadInputTokens);
    if (typeof s.costUsd === 'number') span.setAttribute('tucaken.cost.usd', s.costUsd);
    if (s.systemPromptHash) span.setAttribute('tucaken.prompt.hash', s.systemPromptHash);
    if (s.promptVersion) span.setAttribute('tucaken.prompt.version', s.promptVersion);
    if (s.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: s.error });
    }
    span.end(s.endTimeMs);
}
