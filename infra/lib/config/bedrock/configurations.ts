/**
 * @format
 * Bedrock Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instructions) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getBedrockConfigs } from '../../config/bedrock';
 * const configs = getBedrockConfigs(Environment.PRODUCTION);
 * const instruction = configs.agentInstruction;
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

import { CHATBOT_AGENT_INSTRUCTION } from './chatbot-persona';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Guardrail configuration
 */
export interface GuardrailConfig {
    /** Whether to enable content filtering */
    readonly enableContentFilters: boolean;
    /** Blocked input messaging */
    readonly blockedInputMessaging: string;
    /** Blocked output messaging */
    readonly blockedOutputMessaging: string;
}

/**
 * API Gateway configuration
 */
export interface ApiConfig {
    /** Whether to require API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
    /** SSM parameter prefix for RDS connection params e.g. /k8s/development/platform-rds */
    readonly rdsSsmPrefix: string;
    /** SecretsManager secret name containing RDS username/password */
    readonly rdsCredentialsSecretName: string;
    /** Chatbot retrieval source feature flag ('bedrock-agent' | 'rds-pgvector') */
    readonly chatbotRetrievalSource: string;
    /** Portfolio owner user ID — scopes sessions + RLS in chat_sessions/chat_messages */
    readonly portfolioOwnerUserId: string;
    /** Platform VPC id — when set, RAG lambdas are attached to reach the private RDS.
     *  Omit (staging/prod until wired) to keep lambdas outside any VPC. */
    readonly vpcId?: string;
    /** Subnet ids the RAG lambdas (and the Bedrock interface endpoint) run in. */
    readonly lambdaSubnetIds?: string[];
    /** AZs of `lambdaSubnetIds`, same order — required by Vpc.fromVpcAttributes. */
    readonly lambdaSubnetAzs?: string[];
    /** CIDR of the platform VPC — required by Vpc.fromVpcAttributes for endpoints. */
    readonly vpcCidrBlock?: string;
    /** Security group id of the platform RDS — a 5432 ingress rule from the
     *  lambda SG is added so the lambdas can connect. */
    readonly dbSecurityGroupId?: string;
}

/**
 * Knowledge Base configuration
 */
export interface KnowledgeBaseConfig {
    /** Secrets Manager secret name for Pinecone API key */
    readonly pineconeSecretName: string;
    /** Knowledge Base description */
    readonly description: string;
    /** Knowledge Base instruction for agent interaction */
    readonly instruction: string;
}

/**
 * Complete resource configurations for Bedrock project
 */
export interface BedrockConfigs {
    /** Agent instruction prompt — defines agent behavior */
    readonly agentInstruction: string;
    /** Agent description */
    readonly agentDescription: string;
    /** Guardrail configuration */
    readonly guardrail: GuardrailConfig;
    /** Knowledge Base configuration */
    readonly knowledgeBase: KnowledgeBaseConfig;
    /** API Gateway configuration */
    readonly api: ApiConfig;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Whether to create customer-managed KMS keys */
    readonly createKmsKeys: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource configurations by environment.
 *
 * Agent instruction prompt is imported from the canonical source:
 * @see applications/chatbot/src/prompts/chatbot-persona.ts
 */

export const BEDROCK_CONFIGS: Record<DeployableEnvironment, BedrockConfigs> = {
    [Environment.DEVELOPMENT]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant (development)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-dev/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base (development)',
            // Gap A7: Precise retrieval instruction — guides the agent to search across
            // all portfolio topic areas listed in the agent instruction (KB TOPICS section).
            instruction:
                'Answers portfolio questions: AWS CDK, Kubernetes, AI/ML, CI/CD, Next.js, ' +
                'observability, AWS certs. Always retrieve context before answering. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['http://localhost:3000', 'https://nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/development/platform-rds',
            rdsCredentialsSecretName: 'k8s-development/platform-rds/credentials',
            // Pinecone-backed Bedrock Agent KB decommissioned — dev now reads the
            // same RDS pgvector store as staging/production (returns chunk text, not refs).
            chatbotRetrievalSource: 'rds-pgvector',
            // Owner whose KB (document_embeddings, RLS-scoped) the chatbot retrieves.
            // Dev default is the seeded portfolio-owner test-user
            // (lamounier_88@hotmail.com → 1d4c645a-…); the all-zeros placeholder has
            // zero embeddings, so retrieval returned nothing before this was set.
            portfolioOwnerUserId: process.env['PORTFOLIO_OWNER_USER_ID'] ?? '1d4c645a-447e-4b5b-924d-19a3c75a84db',
            // Platform VPC (k8s-owned) wiring so the RAG lambdas can reach the
            // PRIVATE platform-rds. Reach Bedrock via an interface endpoint
            // (this VPC has natGateways: 0).
            vpcId: 'vpc-06c460143d78778fe',
            lambdaSubnetIds: ['subnet-078e411c08f54d539', 'subnet-027ebf40f0edca13f'],
            lambdaSubnetAzs: ['eu-west-1a', 'eu-west-1b'],
            vpcCidrBlock: '10.0.0.0/16',
            dbSecurityGroupId: 'sg-0a3858a82377815de',
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant (staging)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-stg/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base (staging)',
            // Gap A7: Consistent with development — precise retrieval guidance.
            instruction:
                'Answers portfolio questions: AWS CDK, Kubernetes, AI/ML, CI/CD, Next.js, ' +
                'observability, AWS certs. Always retrieve context before answering. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://staging.nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/staging/platform-rds',
            rdsCredentialsSecretName: 'k8s-staging/platform-rds/credentials',
            chatbotRetrievalSource: 'rds-pgvector',
            portfolioOwnerUserId: process.env['PORTFOLIO_OWNER_USER_ID'] ?? '00000000-0000-0000-0000-000000000001',
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        agentInstruction: CHATBOT_AGENT_INSTRUCTION,
        agentDescription: 'Portfolio AI assistant',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        knowledgeBase: {
            pineconeSecretName: 'bedrock-prd/pinecone-api-key',
            description: 'Portfolio repository documentation knowledge base',
            // Gap A7: Production instruction adds citation requirement for higher grounding precision.
            instruction:
                'Answers portfolio questions: AWS, K8s, AI/ML, CI/CD, Next.js, observability. ' +
                'Retrieve context before answering and cite specific documents. No general knowledge.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/production/platform-rds',
            rdsCredentialsSecretName: 'k8s-production/platform-rds/credentials',
            chatbotRetrievalSource: 'rds-pgvector',
            portfolioOwnerUserId: process.env['PORTFOLIO_OWNER_USER_ID'] ?? '00000000-0000-0000-0000-000000000001',
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Bedrock configurations for an environment
 */
export function getBedrockConfigs(env: Environment): BedrockConfigs {
    return BEDROCK_CONFIGS[env as DeployableEnvironment];
}
