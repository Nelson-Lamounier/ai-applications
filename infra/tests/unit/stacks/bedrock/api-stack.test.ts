/**
 * @format
 * Bedrock API Stack Unit Tests
 *
 * Tests for the BedrockApiStack:
 * - API Gateway REST API with correct name
 * - API Key and Usage Plan (throttling)
 * - Request Validator configured
 * - RAG chatbot Lambdas with correct env vars and runtime
 * - IAM policy for bedrock:Converse / InvokeModel
 * - CloudWatch access log group
 * - SSM parameter exports
 * - Stack outputs
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockApiStack } from '../../../../lib/stacks/bedrock/api-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';

/**
 * Helper to create BedrockApiStack with sensible defaults.
 */
function createApiStack(
    overrides?: Partial<ConstructorParameters<typeof BedrockApiStack>[2]>,
): { stack: BedrockApiStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new BedrockApiStack(
        app,
        'TestBedrockApiStack',
        {
            namePrefix: NAME_PREFIX,
            environmentName: 'development',
            lambdaMemoryMb: 256,
            lambdaTimeoutSeconds: 60,
            logRetention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
            chatbotModel: 'eu.anthropic.claude-sonnet-4-6',
            portfolioOwnerUserId: '00000000-0000-0000-0000-000000000001',
            rdsSsmPrefix: '/k8s/development/platform-rds',
            rdsCredentialsSecretName: 'k8s-development/platform-rds/credentials',
            env: TEST_ENV_EU,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('BedrockApiStack', () => {

    // =========================================================================
    // API Gateway
    // =========================================================================
    describe('API Gateway', () => {
        const { template } = createApiStack();

        it('should create a REST API with correct name', () => {
            template.hasResourceProperties('AWS::ApiGateway::RestApi', {
                Name: `${NAME_PREFIX}-agent-api`,
            });
        });
    });

    // =========================================================================
    // API Key + Usage Plan
    // =========================================================================
    describe('API Key and Usage Plan', () => {
        it('should create an API Key when enableApiKey is true', () => {
            const { template } = createApiStack({ enableApiKey: true });
            template.hasResourceProperties('AWS::ApiGateway::ApiKey', {
                Name: `${NAME_PREFIX}-agent-api-key`,
                Enabled: true,
            });
        });

        it('should create a Usage Plan when enableApiKey is true', () => {
            const { template } = createApiStack({ enableApiKey: true });
            template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
                UsagePlanName: `${NAME_PREFIX}-usage-plan`,
                Throttle: Match.objectLike({
                    RateLimit: 10,
                    BurstLimit: 20,
                }),
            });
        });

        it('should NOT create an API Key when enableApiKey is false', () => {
            const { template } = createApiStack({ enableApiKey: false });
            template.resourceCountIs('AWS::ApiGateway::ApiKey', 0);
        });
    });

    // =========================================================================
    // Request Validator
    // =========================================================================
    describe('Request Validation', () => {
        const { template } = createApiStack();

        it('should create a request validator', () => {
            template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
                Name: `${NAME_PREFIX}-invoke-validator`,
                ValidateRequestBody: true,
            });
        });

        it('should define the chatbot request model', () => {
            template.hasResourceProperties('AWS::ApiGateway::Model', {
                ContentType: 'application/json',
                Name: 'ChatbotInvokeRequest',
            });
        });
    });

    // =========================================================================
    // Lambda — runtime + sizing (RAG chatbot Lambdas)
    // =========================================================================
    describe('Lambda runtime and sizing', () => {
        const { template } = createApiStack();

        it('should NOT create the legacy invoke-agent Lambda', () => {
            const lambdas = template.findResources('AWS::Lambda::Function');
            const names = Object.values(lambdas)
                .map((l) => (l as { Properties?: { FunctionName?: string } }).Properties?.FunctionName)
                .filter(Boolean);
            expect(names).not.toContain(`${NAME_PREFIX}-invoke-agent`);
        });

        it('should use Node.js 22 runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs22.x',
            });
        });

        it('should set 256 MB memory', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 256,
            });
        });

        it('should set 60 second timeout', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Timeout: 60,
            });
        });
    });

    // =========================================================================
    // IAM — decommissioned agent permissions must be absent
    // =========================================================================
    describe('IAM Policies', () => {
        const { template } = createApiStack();

        it('should NOT grant bedrock:InvokeAgent anywhere', () => {
            const policies = template.findResources('AWS::IAM::Policy');
            const actions = JSON.stringify(policies);
            expect(actions).not.toContain('bedrock:InvokeAgent');
        });
    });

    // =========================================================================
    // CloudWatch Access Log Group
    // =========================================================================
    describe('CloudWatch Access Logging', () => {
        const { template } = createApiStack();

        it('should create an access log group for the API', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/apigateway/${NAME_PREFIX}-agent-api`,
                RetentionInDays: 7,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createApiStack();

        it('should create SSM parameter for API URL', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/api-url`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createApiStack();

        it('should output the API URL', () => {
            template.hasOutput('ApiUrl', {});
        });

        it('should output the API ID', () => {
            template.hasOutput('ApiId', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createApiStack();

        it('should expose api', () => {
            expect(stack.api).toBeDefined();
        });

        it('should expose chatbotPublicFunction', () => {
            expect(stack.chatbotPublicFunction).toBeDefined();
        });

        it('should expose chatbotAuthFunction', () => {
            expect(stack.chatbotAuthFunction).toBeDefined();
        });

        it('should expose apiUrl', () => {
            expect(stack.apiUrl).toBeDefined();
        });

        it('should expose apiKey when enableApiKey is true', () => {
            expect(stack.apiKey).toBeDefined();
        });
    });

    // =========================================================================
    // chatbot-public Lambda
    // =========================================================================
    describe('chatbot-public Lambda', () => {
        const { template } = createApiStack();

        it('should create chatbot-public Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-chatbot-public`,
            });
        });

        it('should inject CHATBOT_MODEL and PORTFOLIO_OWNER_USER_ID env vars', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-chatbot-public`,
                Environment: {
                    Variables: Match.objectLike({
                        CHATBOT_MODEL: 'eu.anthropic.claude-sonnet-4-6',
                        PORTFOLIO_OWNER_USER_ID: '00000000-0000-0000-0000-000000000001',
                    }),
                },
            });
        });

        it('should inject RDS connection env vars', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-chatbot-public`,
                Environment: {
                    Variables: Match.objectLike({
                        RDS_HOST: Match.anyValue(),
                        RDS_PORT: Match.anyValue(),
                        RDS_DB_NAME: Match.anyValue(),
                        RDS_USER: Match.anyValue(),
                        RDS_PASSWORD: Match.anyValue(),
                    }),
                },
            });
        });

        it('should grant Bedrock Converse + InvokeModel permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'bedrock:Converse',
                                'bedrock:InvokeModel',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // chatbot-authenticated Lambda
    // =========================================================================
    describe('chatbot-authenticated Lambda', () => {
        const { template } = createApiStack();

        it('should create chatbot-authenticated Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-chatbot-authenticated`,
            });
        });

        it('should inject RDS and chatbot env vars', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-chatbot-authenticated`,
                Environment: {
                    Variables: Match.objectLike({
                        CHATBOT_MODEL: 'eu.anthropic.claude-sonnet-4-6',
                        PORTFOLIO_OWNER_USER_ID: '00000000-0000-0000-0000-000000000001',
                        RDS_HOST: Match.anyValue(),
                    }),
                },
            });
        });
    });

    // =========================================================================
    // API Routes
    // =========================================================================
    describe('API Routes', () => {
        const { template } = createApiStack();

        it('should NOT create the legacy /invoke resource', () => {
            const resources = template.findResources('AWS::ApiGateway::Resource');
            const paths = Object.values(resources)
                .map((r) => (r as { Properties?: { PathPart?: string } }).Properties?.PathPart);
            expect(paths).not.toContain('invoke');
        });

        it('should create POST /invoke-public resource', () => {
            template.hasResourceProperties('AWS::ApiGateway::Resource', {
                PathPart: 'invoke-public',
            });
        });

        it('should create POST /invoke-authenticated resource', () => {
            template.hasResourceProperties('AWS::ApiGateway::Resource', {
                PathPart: 'invoke-authenticated',
            });
        });
    });

    // =========================================================================
    // SSM Exports — chatbot URLs
    // =========================================================================
    describe('SSM Chatbot URL Exports', () => {
        const { template } = createApiStack();

        it('should export chatbot-public API URL to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/chatbot-public-api-url`,
            });
        });

        it('should export chatbot-authenticated API URL to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/chatbot-authenticated-api-url`,
            });
        });
    });
});
