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
 * const origins = configs.api.allowedOrigins;
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';


// =============================================================================
// TYPE DEFINITIONS
// =============================================================================


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
    /** SSM parameter holding the portfolio owner user ID for sessions + RLS */
    readonly portfolioOwnerUserIdParameterName: string;
    /** Shared VPC wiring for the RAG Lambdas (omit to skip VPC attachment). */
    readonly chatbotVpc?: ChatbotVpcConfig;
}

/**
 * IAM role names (Pod Identity association roles, not ARNs) granted scoped
 * access to the article-assets bucket. Discovered live via
 * `aws eks list-pod-identity-associations` / `describe-pod-identity-association`
 * against the tucaken-infra-managed EksPodIdentity-<env> stack — these roles
 * are NOT created by this repo.
 */
export interface ArticleAssetsRolesConfig {
    /** admin-api's runtime role — granted s3:PutObject/DeleteObject under images|videos/articles/*. */
    readonly adminRoleName: string;
    /** public-api's runtime role — granted s3:GetObject under images/articles/*. */
    readonly readerRoleName: string;
}

/**
 * Complete resource configurations for Bedrock project
 */
export interface BedrockConfigs {
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
    /** Runtime role names granted access to the article-assets bucket */
    readonly articleAssets: ArticleAssetsRolesConfig;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource configurations by environment.
 */

export const BEDROCK_CONFIGS: Record<DeployableEnvironment, BedrockConfigs> = {
    [Environment.DEVELOPMENT]: {
        api: {
            enableApiKey: true,
            allowedOrigins: ['http://localhost:3000', 'https://nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/development/platform-rds',
            rdsCredentialsSecretName: 'k8s-development/platform-rds/credentials',
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
        // Discovered 2026-07-06 via `aws eks list-pod-identity-associations` /
        // `describe-pod-identity-association` against k8s-eks-development
        // (associations a-4mizmqiy9p3ttok14 / a-6fabmnn98toakc4au). These
        // roles are provisioned by tucaken-infra's EksPodIdentity-development
        // stack, not by this repo.
        articleAssets: {
            adminRoleName: 'EksPodIdentity-development-Roleadminapi5EAE4B6E-gYZToUb4xsCc',
            readerRoleName: 'EksPodIdentity-development-Rolepublicapi88CC20CC-xv2h0dN8FPQ8',
        },
    },

    [Environment.STAGING]: {
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://staging.nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/staging/platform-rds',
            rdsCredentialsSecretName: 'k8s-staging/platform-rds/credentials',
            portfolioOwnerUserIdParameterName: '/bedrock-stg/portfolio-owner-user-id',
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
        // TODO: no staging EKS cluster exists yet — placeholder role names.
        // Replace with the real Pod Identity association role names (see the
        // development entry above for the discovery commands) before this
        // environment is ever deployed.
        articleAssets: {
            adminRoleName: 'EksPodIdentity-staging-admin-api-TBD',
            readerRoleName: 'EksPodIdentity-staging-public-api-TBD',
        },
    },

    [Environment.PRODUCTION]: {
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
            rdsSsmPrefix: '/k8s/production/platform-rds',
            rdsCredentialsSecretName: 'k8s-production/platform-rds/credentials',
            portfolioOwnerUserIdParameterName: '/bedrock-prd/portfolio-owner-user-id',
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
        // TODO: no production EKS cluster exists yet — placeholder role names.
        // Replace with the real Pod Identity association role names (see the
        // development entry above for the discovery commands) before this
        // environment is ever deployed.
        articleAssets: {
            adminRoleName: 'EksPodIdentity-production-admin-api-TBD',
            readerRoleName: 'EksPodIdentity-production-public-api-TBD',
        },
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
