/**
 * @format
 * X-Ray trace-id parsing — single source for both the Lambda observability
 * helper and the logger. Pure env parse with NO aws-xray-sdk dependency, so
 * importing it never pulls the X-Ray SDK into the K8s bundle.
 */

/**
 * Parse the active X-Ray trace + parent-segment ids from the per-invocation
 * `_X_AMZN_TRACE_ID` env var Lambda populates
 * (`Root=1-...;Parent=<id>;Sampled=1`). Returns `{}` when absent (local / K8s).
 */
export function xrayTraceContextFromEnv(): { trace_id?: string; span_id?: string } {
    try {
        const header = process.env['_X_AMZN_TRACE_ID'];
        if (!header) return {};
        const out: { trace_id?: string; span_id?: string } = {};
        for (const kv of header.split(';')) {
            const eq = kv.indexOf('=');
            if (eq < 0) continue;
            const key = kv.slice(0, eq).trim();
            const value = kv.slice(eq + 1).trim();
            if (key === 'Root' && value) out.trace_id = value;
            else if (key === 'Parent' && value) out.span_id = value;
        }
        return out;
    } catch {
        return {};
    }
}
