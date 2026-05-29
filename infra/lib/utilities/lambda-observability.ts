/**
 * @format
 * Reusable observability wiring for NodejsFunction Lambdas.
 *
 * Tracing is AWS-native X-Ray — NO external ADOT/OpenTelemetry layer (AWS
 * deprecates managed layer versions, which repeatedly broke deploys with
 * lambda:GetLayerVersion AccessDenied). Each Function enables it with
 * `tracing: lambda.Tracing.ACTIVE` (a construction-time prop this helper
 * cannot set); the Lambda service then creates an X-Ray segment per
 * invocation. Handler code calls `withSpan(...)` from
 * @bedrock/shared/observability/lambda for a top-level subsegment, and wraps
 * AWS SDK v3 clients with `AWSXRay.captureAWSv3Client(...)` for downstream
 * subsegments (Bedrock / DynamoDB / etc.).
 *
 * This helper sets the shared observability env (OTEL_SERVICE_NAME for the
 * agent-runner's service field, DEPLOY_ENV, LOG_LEVEL) and grants the X-Ray
 * publish IAM. Metrics (EMF) and logs are layer-independent.
 */

import * as cdk from 'aws-cdk-lib';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import type { Construct } from 'constructs';

/**
 * Modules the @bedrock/shared barrel reaches into but Lambdas must NEVER
 * bundle. They belong to the K8s observability path
 * (bootstrapK8sObservability + Pushgateway helpers) and would explode
 * Lambda cold-start if pulled in. Mark each as external so esbuild leaves
 * the require() calls in place; at runtime the lazy requires inside
 * `shared/observability/k8s.ts` never fire on Lambda because we never
 * call bootstrap from a Function.
 *
 * `@opentelemetry/*` — provided by the ADOT layer at /opt at runtime.
 * `pino`, `prom-client`, `@pyroscope/*`, `pg` — only used by K8s workloads.
 *
 * Apply via `bundling.externalModules` on every NodejsFunction:
 *   externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES]
 */
export const OBSERVABILITY_EXTERNAL_MODULES = [
    // NOTE: '@opentelemetry/*' is intentionally NOT here. Lambdas no longer
    // use the ADOT layer (which provided @opentelemetry/* at /opt) — tracing
    // is AWS-native X-Ray via aws-xray-sdk-core, which MUST bundle. These
    // remaining modules are the K8s-only observability path (Pushgateway /
    // Pino / Pyroscope / pg) and would bloat Lambda cold-start.
    '@pyroscope/*',
    'pino',
    'prom-client',
    'pg',
] as const;

export interface AddLambdaObservabilityOptions {
    /** Logical service name; surfaced as OTEL_SERVICE_NAME (read by the agent
     *  runner's log/EMF `service` field) and used to name the X-Ray service. */
    serviceName: string;
    /**
     * Deployment environment — flows through to:
     *   DEPLOY_ENV          (read by `@bedrock/shared` logger)
     *   AWS Tag environment (existing TaggingAspect handles this)
     *   LOG_LEVEL default   (debug in dev, info elsewhere)
     *
     * Use the Environment enum from `lib/config/environments` — full names
     * ('development' / 'staging' / 'production'), never abbreviations.
     */
    environment: string;
    /** Override default log level. Default: debug in development, info elsewhere. */
    logLevel?:    'trace' | 'debug' | 'info' | 'warn' | 'error';
    /** Extra env vars to merge alongside the standard observability set. */
    extraEnv?: Record<string, string>;
}

/**
 * Wire AWS-native X-Ray observability env + IAM onto a Lambda.
 *
 * IMPORTANT: this helper CANNOT enable tracing — `tracing: lambda.Tracing.ACTIVE`
 * is a construction-time NodejsFunction prop and must be set on each Function
 * definition. Without it the Lambda service never creates an X-Ray segment and
 * `withSpan`/`captureAWSv3Client` subsegments silently no-op.
 *
 * Idempotent — calling twice on the same Function is harmless.
 */
export function addLambdaObservability(
    scope: Construct,
    fn: lambda.Function,
    opts: AddLambdaObservabilityOptions,
): void {
    void scope; // kept for signature stability across call sites

    const isDev    = opts.environment === 'development';
    const logLevel = opts.logLevel ?? (isDev ? 'debug' : 'info');

    // Service identity for logs/EMF (agent-runner reads OTEL_SERVICE_NAME).
    fn.addEnvironment('OTEL_SERVICE_NAME', opts.serviceName);
    // Flows into @bedrock/shared logger — every log line gains
    // env=<environment>, joinable with metrics + traces in Grafana.
    fn.addEnvironment('DEPLOY_ENV', opts.environment);
    fn.addEnvironment('LOG_LEVEL',  logLevel);

    if (opts.extraEnv) {
        for (const [k, v] of Object.entries(opts.extraEnv)) {
            fn.addEnvironment(k, v);
        }
    }

    // X-Ray active tracing publishes via the Lambda service role. Grant the
    // canonical send permissions so segments/subsegments aren't dropped.
    fn.addToRolePolicy(new iam.PolicyStatement({
        sid:     'XRayWrite',
        effect:  iam.Effect.ALLOW,
        actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
        ],
        resources: ['*'],
    }));

    cdk.Tags.of(fn).add('observability', 'xray');
}

/**
 * Wire ADOT + observability env onto every Lambda Function in `scope`. Use at
 * the end of a stack constructor to cover stacks with many tool Lambdas
 * (e.g. self-healing gateway-stack with 10+ AgentCore tool functions)
 * without editing each NodejsFunction block.
 *
 * Service name derives from each Function's logical id — a Function with id
 * 'DiagnoseAlarmFunction' becomes service.name = '<prefix>-diagnoseAlarm'.
 * Stable across redeploys; appears in Tempo + X-Ray the same way every time.
 */
export function addLambdaObservabilityToAll(
    scope: Construct,
    opts: Omit<AddLambdaObservabilityOptions, 'serviceName'> & {
        /** Prefix prepended to each Lambda's id when forming service.name. */
        serviceNamePrefix: string;
    },
): void {
    const functions = scope.node.findAll().filter(
        (c): c is lambda.Function => c instanceof lambda.Function,
    );

    for (const fn of functions) {
        // 'DiagnoseAlarmFunction' → 'diagnoseAlarm'
        const tail = fn.node.id
            .replace(/Function$/, '')
            .replace(/^([A-Z])/, (m) => m.toLowerCase());

        addLambdaObservability(scope, fn, {
            ...opts,
            serviceName: `${opts.serviceNamePrefix}-${tail}`,
        });
    }
}
