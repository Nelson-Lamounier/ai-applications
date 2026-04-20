/**
 * @format
 * Aurora Serverless v2 + pgvector — Behaviour Configurations
 *
 * Controls DB identity, retention, and pgvector schema settings per environment.
 * Configurations are "how it behaves" — policies, names, dimension sizes.
 *
 * Embedding dimension:
 *   Amazon Titan Embed Text v2 produces 1024-dimensional vectors.
 *   This must match the `vector(N)` column type in the bootstrapped schema.
 *
 * Usage:
 * ```typescript
 * import { getAuroraConfigs } from '../../config/bedrock/aurora-configurations';
 * const configs = getAuroraConfigs(Environment.DEVELOPMENT);
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AuroraConfig {
    /** PostgreSQL database name created during cluster bootstrap. */
    readonly databaseName: string;
    /**
     * Embedding vector dimension. Must match the Bedrock embedding model output.
     * Titan Embed Text v2 → 1024. Changing this after deploy requires table migration.
     */
    readonly embeddingDimension: number;
    /** CloudWatch log retention for the bootstrap custom resource Lambda. */
    readonly logRetention: logs.RetentionDays;
    /**
     * CDK removal policy for the Aurora cluster and VPC.
     * DESTROY in non-production to avoid orphaned clusters on stack teardown.
     */
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// ENVIRONMENT CONFIGURATIONS
// =============================================================================

const AURORA_CONFIGURATIONS: Record<DeployableEnvironment, AuroraConfig> = {
    [Environment.DEVELOPMENT]: {
        databaseName: 'portfolio_kb',
        embeddingDimension: 1024,   // Titan Embed Text v2
        logRetention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
    [Environment.STAGING]: {
        databaseName: 'portfolio_kb',
        embeddingDimension: 1024,
        logRetention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
    [Environment.PRODUCTION]: {
        databaseName: 'portfolio_kb',
        embeddingDimension: 1024,
        logRetention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
};

// =============================================================================
// ACCESSOR
// =============================================================================

export function getAuroraConfigs(environment: Environment): AuroraConfig {
    return AURORA_CONFIGURATIONS[environment as DeployableEnvironment];
}
