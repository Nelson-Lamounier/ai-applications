/**
 * @format
 * Bedrock API Stack
 *
 * API Gateway + Lambda frontend for the RAG chatbots (RDS pgvector).
 * The former Bedrock Agent /invoke path was decommissioned 2026-07.
 *
 * Security features:
 * - API Key stored in Secrets Manager — value injected via CF dynamic reference
 *   so the BFF proxy can retrieve it at runtime without manual rotation (Gap S2)
 * - Request body validation
 * - CloudWatch access logging
 * - No browser CORS — endpoint is BFF-only (server-to-server), not browser-facing
 */

import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import type { Construct } from 'constructs';

import type { ChatbotVpcConfig } from '../../config/bedrock/configurations';
import { addLambdaObservability, OBSERVABILITY_EXTERNAL_MODULES } from '../../utilities/lambda-observability';


/**
 * Props for BedrockApiStack
 */
export interface BedrockApiStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Runtime environment name (e.g. 'development') — used for resource naming */
    readonly environmentName: string;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Whether to enable API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins — used by Lambda ALLOWED_ORIGINS env var only.
     *  No browser CORS is set on API Gateway itself (BFF-only endpoint). */
    readonly allowedOrigins: string[];
    /** API Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** API Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
    /** Bedrock model ID for RAG-based chatbot Lambdas */
    readonly chatbotModel: string;
    /** Portfolio owner user ID — scopes sessions + RLS in chat tables */
    readonly portfolioOwnerUserId?: string;
    /** SSM parameter holding the portfolio owner user ID when it is not passed directly */
    readonly portfolioOwnerUserIdParameterName?: string;
    /** SSM prefix for RDS connection params e.g. /k8s/development/platform-rds */
    readonly rdsSsmPrefix: string;
    /** SecretsManager secret name containing RDS username/password */
    readonly rdsCredentialsSecretName: string;
    /** Shared VPC wiring for RAG Lambdas that need private RDS access. */
    readonly chatbotVpc?: ChatbotVpcConfig;
}

/**
 * API Stack for Bedrock Agent.
 *
 * Creates a secured REST API Gateway backed by a Lambda function that
 * invokes the Bedrock Agent using the AWS SDK.
 */
export class BedrockApiStack extends cdk.Stack {
    /** The API Gateway REST API */
    public readonly api: apigateway.RestApi;

    /** Public RAG chatbot Lambda (stateless, RDS pgvector) */
    public readonly chatbotPublicFunction: lambdaNode.NodejsFunction;

    /** Authenticated RAG chatbot Lambda (session-aware, always uses pgvector) */
    public readonly chatbotAuthFunction: lambdaNode.NodejsFunction;

    /** The API URL */
    public readonly apiUrl: string;

    /** The API Key (if enabled) */
    public readonly apiKey?: apigateway.IApiKey;

    /**
     * ARN of the Secrets Manager secret holding the API key value.
     *
     * Exported to SSM so the BFF proxy (public-api) can retrieve the key
     * at runtime via the EC2 instance profile — no static credentials needed.
     * Only set when `enableApiKey` is true.
     */
    public readonly apiKeySecretArn?: string;

    constructor(scope: Construct, id: string, props: BedrockApiStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // RDS connection params — read from SSM, injected into RAG Lambdas
        // =================================================================
        const rdsPort     = ssm.StringParameter.valueForStringParameter(this, `${props.rdsSsmPrefix}/port`);
        const rdsDatabase = ssm.StringParameter.valueForStringParameter(this, `${props.rdsSsmPrefix}/database`);
        const rdsUser     = ssm.StringParameter.valueForStringParameter(this, `${props.rdsSsmPrefix}/user`);
        const rdsSecret   = secretsmanager.Secret.fromSecretNameV2(this, 'RdsCredentialsSecret', props.rdsCredentialsSecretName);

        // Host and password are resolved at RUNTIME by hydrateRdsEnv() from the
        // pointers below, not baked into the function environment at deploy time —
        // so a database endpoint rename (snapshot-restore migration) or a master
        // password rotation is picked up on the next cold start without a redeploy,
        // and no plaintext password ever lands in the Lambda environment.
        const rdsEnvVars = {
            RDS_PORT:        rdsPort,
            RDS_DB_NAME:     rdsDatabase,
            RDS_USER:        rdsUser,
            RDS_SSM_PREFIX:  props.rdsSsmPrefix,
            RDS_SECRET_NAME: props.rdsCredentialsSecretName,
        };
        const portfolioOwnerUserId = props.portfolioOwnerUserId ??
            ssm.StringParameter.valueForStringParameter(
                this,
                props.portfolioOwnerUserIdParameterName ?? `/${namePrefix}/portfolio-owner-user-id`,
            );

        // Chatbot lambdas bundle pg — do NOT exclude it (unlike K8s workloads).
        const chatbotExternalModules = OBSERVABILITY_EXTERNAL_MODULES.filter(m => m !== 'pg');

        const chatbotVpcProps = props.chatbotVpc
            ? this.buildChatbotVpcProps(props.chatbotVpc)
            : {};
        const chatbotFoundationModelId = props.chatbotModel.replace(/^eu\./, '');
        const euInferenceProfileRegions = [
            'eu-north-1',
            'eu-west-3',
            'eu-south-1',
            'eu-south-2',
            'eu-west-1',
            'eu-central-1',
        ];
        const chatbotModelResources = [
            `arn:aws:bedrock:${this.region}::foundation-model/${props.chatbotModel}`,
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.chatbotModel}`,
            `arn:aws:bedrock:${this.region}:${this.account}:application-inference-profile/${props.chatbotModel}`,
            `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
            ...euInferenceProfileRegions.map(region =>
                `arn:aws:bedrock:${region}::foundation-model/${chatbotFoundationModelId}`,
            ),
        ];

        // =================================================================
        // chatbot-public Lambda — stateless RAG (RDS pgvector)
        // =================================================================
        this.chatbotPublicFunction = new lambdaNode.NodejsFunction(this, 'ChatbotPublicFunction', {
            functionName: `${namePrefix}-chatbot-public`,
            runtime: lambda.Runtime.NODEJS_22_X,
            tracing: lambda.Tracing.ACTIVE,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'chatbot-public', 'src', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            ...chatbotVpcProps,
            environment: {
                CHATBOT_MODEL: props.chatbotModel,
                PORTFOLIO_OWNER_USER_ID: portfolioOwnerUserId,
                ALLOWED_ORIGINS: props.allowedOrigins.join(','),
                ...rdsEnvVars,
            },
            description: `Public RAG chatbot handler for ${namePrefix}`,
            logGroup: new logs.LogGroup(this, 'ChatbotPublicLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-chatbot-public`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...chatbotExternalModules],
            },
        });

        NagSuppressions.addResourceSuppressions(
            this.chatbotPublicFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        addLambdaObservability(this, this.chatbotPublicFunction, {
            serviceName: `${namePrefix}-chatbot-public`,
            environment: props.environmentName,
        });

        this.chatbotPublicFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ChatbotPublicBedrockAccess',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:Converse', 'bedrock:InvokeModel'],
            resources: chatbotModelResources,
        }));

        // =================================================================
        // chatbot-authenticated Lambda — session-aware RAG (always pgvector)
        // =================================================================
        this.chatbotAuthFunction = new lambdaNode.NodejsFunction(this, 'ChatbotAuthFunction', {
            functionName: `${namePrefix}-chatbot-authenticated`,
            runtime: lambda.Runtime.NODEJS_22_X,
            tracing: lambda.Tracing.ACTIVE,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'chatbot-authenticated', 'src', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            ...chatbotVpcProps,
            environment: {
                CHATBOT_MODEL: props.chatbotModel,
                PORTFOLIO_OWNER_USER_ID: portfolioOwnerUserId,
                ALLOWED_ORIGINS: props.allowedOrigins.join(','),
                ...rdsEnvVars,
            },
            description: `Authenticated session-aware chatbot handler for ${namePrefix}`,
            logGroup: new logs.LogGroup(this, 'ChatbotAuthLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-chatbot-authenticated`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...chatbotExternalModules],
            },
        });

        NagSuppressions.addResourceSuppressions(
            this.chatbotAuthFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        addLambdaObservability(this, this.chatbotAuthFunction, {
            serviceName: `${namePrefix}-chatbot-authenticated`,
            environment: props.environmentName,
        });

        this.chatbotAuthFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ChatbotAuthBedrockAccess',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:Converse', 'bedrock:InvokeModel'],
            resources: chatbotModelResources,
        }));

        // Runtime credential access for hydrateRdsEnv(): both chatbot Lambdas read
        // the RDS host SSM parameter and the credentials secret at cold start,
        // replacing the deploy-time valueForStringParameter / secretValueFromJson
        // injection so a host rename or password rotation needs no redeploy.
        for (const fn of [this.chatbotPublicFunction, this.chatbotAuthFunction]) {
            rdsSecret.grantRead(fn);
            fn.addToRolePolicy(new iam.PolicyStatement({
                sid: 'ReadRdsHostParam',
                effect: iam.Effect.ALLOW,
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.rdsSsmPrefix}/host`,
                ],
            }));
        }

        // =================================================================
        // CloudWatch Log Group — API Gateway Access Logging
        // =================================================================
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            logGroupName: `/aws/apigateway/${namePrefix}-agent-api`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // API Gateway — REST API
        // =================================================================
        // No defaultCorsPreflightOptions — this endpoint is BFF-only (server-to-server).
        // The public-api proxy handles browser CORS for its own /api/chatbot/invoke route.
        // Removing browser CORS from API Gateway prevents direct browser invocation
        // and eliminates the need to distribute x-api-key to the client.
        this.api = new apigateway.RestApi(this, 'AgentApi', {
            restApiName: `${namePrefix}-agent-api`,
            description: `REST API for the ${namePrefix} RAG chatbots (RDS pgvector)`,
            deployOptions: {
                stageName: 'v1',
                tracingEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                    caller: true,
                    httpMethod: true,
                    ip: true,
                    protocol: true,
                    requestTime: true,
                    resourcePath: true,
                    responseLength: true,
                    status: true,
                    user: true,
                }),
                throttlingRateLimit: props.throttlingRateLimit,
                throttlingBurstLimit: props.throttlingBurstLimit,
            },
        });

        // =================================================================
        // Request Validator — Validate body on the chatbot POST routes
        // =================================================================
        const requestValidator = new apigateway.RequestValidator(this, 'InvokeRequestValidator', {
            restApi: this.api,
            requestValidatorName: `${namePrefix}-invoke-validator`,
            validateRequestBody: true,
            validateRequestParameters: false,
        });

        // Define chatbot request model (prompt + optional sessionId + optional callerRole)
        const chatbotInvokeModel = this.api.addModel('ChatbotInvokeRequestModel', {
            contentType: 'application/json',
            modelName: 'ChatbotInvokeRequest',
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ['prompt'],
                properties: {
                    prompt: {
                        type: apigateway.JsonSchemaType.STRING,
                        minLength: 1,
                        maxLength: 10000,
                    },
                    sessionId: { type: apigateway.JsonSchemaType.STRING },
                    callerRole: { type: apigateway.JsonSchemaType.STRING },
                },
            },
        });

        // =================================================================
        // POST /invoke-public — Public stateless RAG chatbot
        // =================================================================
        const invokePublicResource = this.api.root.addResource('invoke-public');
        invokePublicResource.addMethod('POST', new apigateway.LambdaIntegration(this.chatbotPublicFunction), {
            apiKeyRequired: props.enableApiKey,
            requestValidator,
            requestModels: { 'application/json': chatbotInvokeModel },
            methodResponses: [
                { statusCode: '200' },
                { statusCode: '400' },
                { statusCode: '500' },
            ],
        });

        // =================================================================
        // POST /invoke-authenticated — Session-aware RAG chatbot
        // =================================================================
        const invokeAuthResource = this.api.root.addResource('invoke-authenticated');
        invokeAuthResource.addMethod('POST', new apigateway.LambdaIntegration(this.chatbotAuthFunction), {
            apiKeyRequired: props.enableApiKey,
            requestValidator,
            requestModels: { 'application/json': chatbotInvokeModel },
            methodResponses: [
                { statusCode: '200' },
                { statusCode: '400' },
                { statusCode: '500' },
            ],
        });

        // =================================================================
        // API Key + Usage Plan (throttling + quota)
        //
        // Gap S2 — The key value is generated by Secrets Manager and injected
        // into CfnApiKey via a CloudFormation dynamic reference
        // ({{resolve:secretsmanager:...}}). This is the only CDK pattern that
        // lets you both SET a known API key value AND read it back at runtime.
        //
        // The BFF proxy (public-api) reads the secret via the EC2 instance
        // profile at startup — no static key distribution to the browser.
        // =================================================================
        if (props.enableApiKey) {
            // Generate and store the API key value in Secrets Manager.
            // Plain string secret (no generateStringKey) — raw password only.
            const apiKeySecret = new secretsmanager.Secret(this, 'AgentApiKeySecret', {
                secretName: `${namePrefix}/bedrock-api-key`,
                description: `Bedrock chatbot API key for ${namePrefix} BFF proxy`,
                generateSecretString: {
                    // Exclude chars that could cause issues in HTTP headers
                    excludeCharacters: ' !"#$%&\'()*+,/:;<=>?@[\\]^`{|}~',
                    passwordLength: 40,
                },
            });
            apiKeySecret.applyRemovalPolicy(props.removalPolicy);

            NagSuppressions.addResourceSuppressions(
                apiKeySecret,
                [{ id: 'AwsSolutions-SMG4', reason: 'API key secret is statically mapped to CfnApiKey; automatic rotation would break API Gateway mapping without custom Lambdas' }],
            );

            // CfnApiKey resolves the CF dynamic reference at deploy time.
            // apigateway.ApiKey (L2) does not support setting an explicit value,
            // so we drop to L1 here and create an L2 shim for the usage plan.
            const cfnApiKey = new apigateway.CfnApiKey(this, 'AgentApiKeyResource', {
                name: `${namePrefix}-agent-api-key`,
                description: `API Key for ${namePrefix} Bedrock Agent API (managed by Secrets Manager)`,
                enabled: true,
                value: apiKeySecret.secretValue.unsafeUnwrap(),
            });

            // L2 shim — required by UsagePlan.addApiKey()
            this.apiKey = apigateway.ApiKey.fromApiKeyId(this, 'AgentApiKeyL2', cfnApiKey.ref);
            // readonly is assignable in the constructor
            this.apiKeySecretArn = apiKeySecret.secretArn;

            const usagePlan = this.api.addUsagePlan('AgentUsagePlan', {
                name: `${namePrefix}-usage-plan`,
                description: `Usage plan for ${namePrefix} Bedrock Agent API`,
                throttle: {
                    rateLimit: props.throttlingRateLimit,
                    burstLimit: props.throttlingBurstLimit,
                },
                quota: {
                    limit: 10000,
                    period: apigateway.Period.MONTH,
                },
            });

            usagePlan.addApiKey(this.apiKey);
            usagePlan.addApiStage({
                stage: this.api.deploymentStage,
            });
        }

        this.apiUrl = this.api.url;

        // Always publish the secret ARN param so PublicApiStack can unconditionally
        // read it from SSM. Empty string when API key is disabled — PublicApiStack
        // handles the empty-string case at runtime (no secret lookup attempted).
        new ssm.StringParameter(this, 'ApiKeySecretArnParam', {
            parameterName: `/${namePrefix}/bedrock-api-key-secret-arn`,
            stringValue: this.apiKeySecretArn ?? '',
            description: `Secrets Manager ARN for the Bedrock chatbot API key (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================

        // APIG2: Request validation IS enabled via requestValidator + model
        // on POST /invoke (lines above). CDK Nag requires it set at the API
        // level as a default; suppress since it is explicitly wired per-method.
        NagSuppressions.addResourceSuppressions(
            this.api,
            [{ id: 'AwsSolutions-APIG2', reason: 'Request validation is configured per-method with RequestValidator and ChatbotInvokeRequestModel on the chatbot POST routes' }],
            true,
        );

        // APIG4 + COG4: This API uses API Key authentication with Usage Plan
        // throttling — Cognito authorizer is not applicable for this
        // machine-to-machine integration pattern.
        for (const resource of [invokePublicResource, invokeAuthResource]) {
            NagSuppressions.addResourceSuppressions(
                resource,
                [
                    { id: 'AwsSolutions-APIG4', reason: 'API uses API Key authentication with Usage Plan throttling; Cognito not applicable for M2M integration' },
                    { id: 'AwsSolutions-COG4', reason: 'API uses API Key authentication; Cognito user pool authorizer not applicable for M2M integration' },
                ],
                true,
            );
        }

        // APIG3: WAF deferred — Gap S1 in implementation plan.
        // API key is now managed via Secrets Manager (Gap S2) and the endpoint
        // is BFF-only (no browser CORS), significantly reducing the attack surface.
        // WAFv2 REGIONAL WebACL should be added in a follow-up PR.
        NagSuppressions.addResourceSuppressions(
            this.api.deploymentStage,
            [{ id: 'AwsSolutions-APIG3', reason: 'WAFv2 deferred (Gap S1). Endpoint is BFF-only with Secrets Manager-managed API key — see implementation_plan_ChatBot.md S1' }],
            true,
        );

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'ApiUrlParam', {
            parameterName: `/${namePrefix}/api-url`,
            stringValue: this.api.url,
            description: `API Gateway URL for ${namePrefix} agent`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ChatbotPublicApiUrlParam', {
            parameterName: `/${namePrefix}/chatbot-public-api-url`,
            stringValue: `${this.api.url}invoke-public`,
            description: `Public RAG chatbot endpoint URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ChatbotAuthApiUrlParam', {
            parameterName: `/${namePrefix}/chatbot-authenticated-api-url`,
            stringValue: `${this.api.url}invoke-authenticated`,
            description: `Authenticated RAG chatbot endpoint URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            description: 'API Gateway URL',
        });

        new cdk.CfnOutput(this, 'ApiId', {
            value: this.api.restApiId,
            description: 'API Gateway REST API ID',
        });
    }

    private buildChatbotVpcProps(cfg: ChatbotVpcConfig): Pick<
        lambdaNode.NodejsFunctionProps,
        'allowPublicSubnet' | 'securityGroups' | 'vpc' | 'vpcSubnets'
    > {
        // Resolve the shared VPC by attributes rather than Vpc.fromLookup: the vpc
        // id and subnet ids come from tucaken-infra's SSM exports at deploy time.
        // fromLookup forces a synth-time EC2 call, which the --no-lookups CI synth
        // blocks (and cdk.context.json is gitignored, so it cannot be cached).
        // fromVpcAttributes + valueForStringParameter perform no synth-time AWS
        // calls. Subnet ids are a comma-separated SSM string split into the known
        // AZ count (CDK needs the count concrete; the ids themselves stay dynamic).
        const vpcId = ssm.StringParameter.valueForStringParameter(this, cfg.vpcIdSsmParameter);
        const publicSubnetIdsCsv = ssm.StringParameter.valueForStringParameter(this, cfg.publicSubnetIdsSsmParameter);
        const publicSubnetIds = cdk.Fn.split(',', publicSubnetIdsCsv, cfg.availabilityZones.length);
        const vpc = ec2.Vpc.fromVpcAttributes(this, 'ChatbotSharedVpc', {
            vpcId,
            availabilityZones: cfg.availabilityZones,
            publicSubnetIds,
        });
        const vpcSubnets = { subnetType: ec2.SubnetType.PUBLIC };

        const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'ChatbotLambdaSecurityGroup', {
            vpc,
            description: 'Outbound access for Bedrock RAG chatbot Lambdas',
            allowAllOutbound: true,
        });

        const endpointSecurityGroup = new ec2.SecurityGroup(this, 'ChatbotBedrockEndpointSecurityGroup', {
            vpc,
            description: 'Bedrock interface-endpoint access -- VPC-wide (privateDnsEnabled)',
            allowAllOutbound: true,
        });
        // privateDnsEnabled (below) makes these endpoints resolve VPC-WIDE: every
        // pod in the VPC resolves bedrock-runtime.<region>.amazonaws.com to these
        // endpoint ENIs. So the SG MUST admit the whole VPC on 443 -- scoping it to
        // only the chatbot Lambda SG silently dropped (ETIMEDOUT) every other
        // in-VPC Bedrock consumer (ingestion, job-strategist, coach, ...). The VPC
        // CIDR rule is a superset of the chatbot Lambda SG, so it covers both.
        endpointSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(cfg.vpcCidr),
            ec2.Port.tcp(443),
            'HTTPS from the whole VPC (privateDns Bedrock endpoint is VPC-wide)',
        );

        for (const [id, service] of [
            ['ChatbotBedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
            ['ChatbotBedrockAgentRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME],
        ] as const) {
            new ec2.InterfaceVpcEndpoint(this, id, {
                vpc,
                service,
                subnets: vpcSubnets,
                securityGroups: [endpointSecurityGroup],
                privateDnsEnabled: true,
                open: false,
            });
        }

        return {
            allowPublicSubnet: true,
            securityGroups: [lambdaSecurityGroup],
            vpc,
            vpcSubnets,
        };
    }
}
