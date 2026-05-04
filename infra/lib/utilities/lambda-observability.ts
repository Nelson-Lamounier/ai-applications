/**
 * @format
 * Reusable observability wiring for NodejsFunction Lambdas.
 *
 * Attaches the AWS-managed ADOT (AWS Distro for OpenTelemetry) layer and
 * sets the env vars that turn it on:
 *
 *   AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler   — preloads the OTel SDK
 *                                                 before the user handler.
 *   OTEL_SERVICE_NAME=<fn-name>                 — service.name on every span.
 *   OTEL_PROPAGATORS=tracecontext,xray          — accept W3C traceparent
 *                                                 from upstream callers
 *                                                 (admin-api / step funcs)
 *                                                 AND continue X-Ray IDs.
 *
 * Default exporter: AWS X-Ray (the layer's built-in collector config). To
 * forward to Tempo instead, override OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * Adding the ADOT layer only — handler-side code calls `withSpan(...)`
 * from @bedrock/shared/observability/lambda for an explicit top-level
 * span (defensive — auto-instrumentation may miss non-standard signatures).
 */

import * as cdk from 'aws-cdk-lib';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { Construct } from 'constructs';

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
    '@opentelemetry/*',
    '@pyroscope/*',
    'pino',
    'prom-client',
    'pg',
] as const;

/**
 * AWS-published ADOT Lambda layer ARN (Node.js, x86_64, eu-west-1).
 * Update when bumping ADOT versions; layer ARNs are region+arch specific.
 *
 * @see https://aws-otel.github.io/docs/getting-started/lambda/lambda-js
 */
const ADOT_LAYER_ARN_EU_WEST_1 =
    'arn:aws:lambda:eu-west-1:901920570463:layer:aws-otel-nodejs-amd64-ver-1-32-1:1';

export interface AddLambdaObservabilityOptions {
    /** Logical service name surfaced in Tempo / X-Ray. */
    serviceName: string;
    /**
     * Deployment environment — flows through to:
     *   DEPLOY_ENV                       (read by `@bedrock/shared` logger)
     *   OTEL_RESOURCE_ATTRIBUTES         (deployment.environment=...)
     *   AWS Tag environment              (existing TaggingAspect handles this)
     *   LOG_LEVEL default                (debug in dev, info elsewhere)
     *
     * Use the Environment enum from `lib/config/environments` — full names
     * ('development' / 'staging' / 'production'), never abbreviations.
     */
    environment: string;
    /** Override default log level. Default: debug in development, info elsewhere. */
    logLevel?:    'trace' | 'debug' | 'info' | 'warn' | 'error';
    /** Optional override of the ADOT layer ARN (e.g. for arm64 / non-eu-west-1). */
    adotLayerArn?: string;
    /**
     * Override the OTLP exporter endpoint. When unset the ADOT collector
     * uses its built-in X-Ray exporter — the simpler path because Lambda
     * has no in-VPC Alloy connectivity by default.
     */
    otlpEndpoint?: string;
    /** Extra env vars to merge alongside the standard observability set. */
    extraEnv?: Record<string, string>;
}

/**
 * Attach the ADOT layer + standard observability env vars to a Lambda.
 * Idempotent — calling twice on the same Function is harmless.
 */
export function addLambdaObservability(
    scope: Construct,
    fn: lambda.Function,
    opts: AddLambdaObservabilityOptions,
): void {
    const layerArn = opts.adotLayerArn ?? ADOT_LAYER_ARN_EU_WEST_1;
    const layer = lambda.LayerVersion.fromLayerVersionArn(
        scope,
        `${fn.node.id}AdotLayer`,
        layerArn,
    );
    fn.addLayers(layer);

    const isDev    = opts.environment === 'development';
    const logLevel = opts.logLevel ?? (isDev ? 'debug' : 'info');

    fn.addEnvironment('AWS_LAMBDA_EXEC_WRAPPER', '/opt/otel-handler');
    fn.addEnvironment('OTEL_SERVICE_NAME',       opts.serviceName);
    fn.addEnvironment('OTEL_PROPAGATORS',        'tracecontext,xray');
    // Stamp environment on every span. `deployment.environment` is the
    // OpenTelemetry semantic-convention key; Tempo + X-Ray both surface
    // it as a searchable attribute. service.name (set above) carries
    // identity; service.namespace is informational and brittle for
    // hyphenated prefixes (self-healing) so we omit it.
    fn.addEnvironment('OTEL_RESOURCE_ATTRIBUTES',
        `deployment.environment=${opts.environment}`);
    // Flows into @bedrock/shared logger — every log line gains
    // env=<environment>, joinable with metrics + traces in Grafana.
    fn.addEnvironment('DEPLOY_ENV', opts.environment);
    fn.addEnvironment('LOG_LEVEL',  logLevel);

    if (opts.otlpEndpoint) {
        fn.addEnvironment('OTEL_EXPORTER_OTLP_ENDPOINT', opts.otlpEndpoint);
    }
    if (opts.extraEnv) {
        for (const [k, v] of Object.entries(opts.extraEnv)) {
            fn.addEnvironment(k, v);
        }
    }

    // ADOT writes to X-Ray. Grant the function the canonical send permission
    // so it doesn't silently fail to publish segments.
    fn.addToRolePolicy(new iam.PolicyStatement({
        sid:     'XRayWrite',
        effect:  iam.Effect.ALLOW,
        actions: [
            'xray:PutTraceSegments',
            'xray:PutTelemetryRecords',
        ],
        resources: ['*'],
    }));

    cdk.Tags.of(fn).add('observability', 'adot');
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
