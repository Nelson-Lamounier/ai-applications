/**
 * @format
 * Re-exports for the observability sub-namespace under @bedrock/shared.
 */

export { bootstrapK8sObservability, type ObservabilityHandle, type BootstrapOptions } from './k8s';
export { pushFinalMetrics } from './pushgateway';
export { activeTraceContext, withSpan } from './lambda';
export {
    recordBedrockUsage,
    setBedrockMetricsRegistry,
    type BedrockUsage,
    type RecordBedrockUsageArgs,
} from './bedrock';
