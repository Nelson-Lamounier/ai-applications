/**
 * @format
 * Public API Stack
 *
 * API Gateway + Lambda for the public-facing BFF (Backend-for-Frontend).
 * Serves the Next.js portfolio frontend with read-only endpoints:
 *   GET  /api/articles          — list published articles
 *   GET  /api/articles/:slug    — single article by slug
 *   GET  /api/tags              — all tags
 *   GET  /api/resumes/active    — active resume (optional)
 *   POST /api/chatbot/invoke    — proxy to Bedrock chatbot API Gateway
 *   GET  /healthz               — health check
 *
 * No authentication — all routes are public read-only.
 * CORS is handled by the Hono middleware inside the Lambda.
 */

import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

export interface PublicApiStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Runtime environment name */
    readonly environmentName: string;
    /** DynamoDB content table (from BedrockDataStack) */
    readonly contentTable: dynamodb.ITable;
    /** DynamoDB GSI1 index name */
    readonly dynamoGsi1Name: string;
    /** DynamoDB GSI2 index name */
    readonly dynamoGsi2Name: string;
    /** DynamoDB strategist table for resumes (optional) */
    readonly strategistTable?: dynamodb.ITable;
    /** Bedrock chatbot API Gateway URL (from BedrockApiStack) */
    readonly bedrockApiUrl: string;
    /** Secrets Manager ARN for the Bedrock chatbot API key */
    readonly bedrockApiKeySecretArn: string;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** API Gateway throttle — sustained RPS */
    readonly throttlingRateLimit: number;
    /** API Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
}

export class PublicApiStack extends cdk.Stack {
    /** The API Gateway REST API */
    public readonly api: apigateway.RestApi;

    /** The public-api Lambda function */
    public readonly apiFunction: lambdaNode.NodejsFunction;

    /** The public API URL */
    public readonly apiUrl: string;

    constructor(scope: Construct, id: string, props: PublicApiStackProps) {
        super(scope, id, props);

        const {
            namePrefix,
            contentTable,
            strategistTable,
            bedrockApiUrl,
            bedrockApiKeySecretArn,
        } = props;

        // =================================================================
        // Lambda — Hono BFF (public-api/src/lambda.ts)
        // =================================================================
        this.apiFunction = new lambdaNode.NodejsFunction(this, 'PublicApiFunction', {
            functionName: `${namePrefix}-public-api`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'api', 'public-api', 'src', 'lambda.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            environment: {
                // AWS_DEFAULT_REGION is reserved — Lambda injects it automatically
                DYNAMODB_TABLE_NAME: contentTable.tableName,
                DYNAMODB_GSI1_NAME: props.dynamoGsi1Name,
                DYNAMODB_GSI2_NAME: props.dynamoGsi2Name,
                ...(strategistTable && { STRATEGIST_TABLE_NAME: strategistTable.tableName }),
                BEDROCK_API_URL: bedrockApiUrl,
                BEDROCK_API_KEY_SECRET_ARN: bedrockApiKeySecretArn,
                ALLOWED_ORIGINS: props.allowedOrigins.join(','),
            },
            description: `Public BFF API for ${namePrefix} portfolio frontend`,
            logGroup: new logs.LogGroup(this, 'PublicApiFunctionLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-public-api`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        NagSuppressions.addResourceSuppressions(
            this.apiFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        // DynamoDB read permissions
        contentTable.grantReadData(this.apiFunction);
        strategistTable?.grantReadData(this.apiFunction);

        // Secrets Manager — read Bedrock chatbot API key
        const bedrockApiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
            this, 'BedrockApiKeySecret', bedrockApiKeySecretArn,
        );
        bedrockApiKeySecret.grantRead(this.apiFunction);

        // =================================================================
        // API Gateway — REST API with CORS
        // =================================================================
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            logGroupName: `/aws/apigateway/${namePrefix}-public-api`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        this.api = new apigateway.RestApi(this, 'PublicRestApi', {
            restApiName: `${namePrefix}-public-api`,
            description: `Public BFF API for ${namePrefix} portfolio frontend`,
            deployOptions: {
                stageName: 'api',
                tracingEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                    caller: false,
                    httpMethod: true,
                    ip: false,
                    protocol: true,
                    requestTime: true,
                    resourcePath: true,
                    responseLength: true,
                    status: true,
                    user: false,
                }),
                throttlingRateLimit: props.throttlingRateLimit,
                throttlingBurstLimit: props.throttlingBurstLimit,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: props.allowedOrigins,
                allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
                allowHeaders: ['Content-Type', 'Accept'],
                maxAge: cdk.Duration.hours(24),
            },
        });

        // Proxy all requests to the Hono Lambda
        const proxyResource = this.api.root.addResource('{proxy+}');
        const lambdaIntegration = new apigateway.LambdaIntegration(this.apiFunction);

        this.api.root.addMethod('ANY', lambdaIntegration);
        proxyResource.addMethod('ANY', lambdaIntegration);

        // CDK Nag: public-api is intentionally unauthenticated — read-only
        // portfolio data (articles, tags, resumes) and chatbot proxy.
        // CORS + throttling provide adequate protection for a public read API.
        NagSuppressions.addResourceSuppressions(
            this.api,
            [
                { id: 'AwsSolutions-APIG4', reason: 'Public read-only API — no auth required for portfolio data endpoints' },
                { id: 'AwsSolutions-COG4', reason: 'Public read-only API — Cognito not applicable for unauthenticated portfolio endpoints' },
                { id: 'AwsSolutions-APIG2', reason: 'Hono validates request shape internally — API Gateway request validation not applicable for Lambda proxy integration' },
                { id: 'AwsSolutions-APIG3', reason: 'WAFv2 deferred — public read API with throttling; low-value target with no auth or mutation endpoints' },
            ],
            true,
        );

        this.apiUrl = this.api.url;

        // SSM — publish API URL for the Next.js frontend ConfigMap
        new ssm.StringParameter(this, 'PublicApiUrlParam', {
            parameterName: `/bedrock/${props.environmentName}/public-api-url`,
            stringValue: this.api.url,
            description: `Public API Gateway URL for ${namePrefix}`,
        });

        // =================================================================
        // Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'PublicApiUrl', {
            value: this.api.url,
            description: 'Public API Gateway URL',
            exportName: `${namePrefix}-public-api-url`,
        });
    }
}
