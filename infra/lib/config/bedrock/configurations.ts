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
 * Shared-VPC attributes for the RAG chatbot Lambdas. Resolved WITHOUT a
 * synth-time lookup: the vpc id comes from SSM at deploy time and the public
 * subnets are static config, so `cdk synth --no-lookups` (CI) succeeds and no
 * `cdk.context.json` is needed. Omit to skip VPC attachment for an environment.
 */
export interface ChatbotVpcConfig {
    /** SSM parameter holding the shared VPC id (tucaken-infra: /shared/vpc/<env>/vpc-id). */
    readonly vpcIdSsmParameter: string;
    /**
     * SSM parameter holding the comma-separated public subnet ids
     * (tucaken-infra publishes this dynamically from vpc.publicSubnets, so new
     * subnets are picked up automatically). Read + split at deploy time.
     */
    readonly publicSubnetIdsSsmParameter: string;
    /**
     * Availability zones for the public subnets, concrete (CDK requires
     * non-token AZs for an imported VPC). Its length anchors the Fn.split count,
     * so it MUST match the number of public subnets in the SSM list.
     */
    readonly availabilityZones: string[];
    /**
     * VPC CIDR (concrete). The Bedrock interface endpoints use privateDnsEnabled,
     * which makes them resolve VPC-wide, so their security group must admit the
     * whole VPC on 443 -- otherwise non-chatbot Bedrock consumers (ingestion,
     * job-strategist, coach) get connections silently dropped. Concrete because a
     * security-group ingress CIDR cannot be a deploy-time SSM token.
     */
    readonly vpcCidr: string;
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
    /** SSM parameter holding the portfolio owner user ID for sessions + RLS */
    readonly portfolioOwnerUserIdParameterName: string;
    /** Shared VPC wiring for the RAG Lambdas (omit to skip VPC attachment). */
    readonly chatbotVpc?: ChatbotVpcConfig;
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
            portfolioOwnerUserIdParameterName: '/bedrock-dev/portfolio-owner-user-id',
            // Shared VPC wiring read entirely from tucaken-infra's SSM exports
            // (/shared/vpc/development/*) at deploy time -- no hardcoded subnet
            // ids, no synth-time lookup. tucaken-infra publishes public-subnet-ids
            // dynamically, so added subnets flow through without a code change
            // (bump availabilityZones only if the subnet COUNT changes).
            chatbotVpc: {
                vpcIdSsmParameter: '/shared/vpc/development/vpc-id',
                publicSubnetIdsSsmParameter: '/shared/vpc/development/public-subnet-ids',
                availabilityZones: ['eu-west-1a', 'eu-west-1b'],
                vpcCidr: '10.0.0.0/16',
            },
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
            portfolioOwnerUserIdParameterName: '/bedrock-stg/portfolio-owner-user-id',
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
            portfolioOwnerUserIdParameterName: '/bedrock-prd/portfolio-owner-user-id',
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
