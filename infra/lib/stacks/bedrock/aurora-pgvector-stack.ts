/**
 * @format
 * Aurora Serverless v2 + pgvector Stack
 *
 * Replaces Pinecone as the vector store for portfolio KB queries and
 * resume-generation pipelines. All vector search is now self-hosted in
 * Aurora PostgreSQL with the pgvector extension.
 *
 * Architecture:
 *   Bedrock (Titan Embed v2, 1024-dim) → Lambda → Aurora pgvector
 *   Query Lambda → RDS Data API → cosine similarity search (HNSW index)
 *
 * Key design decisions:
 *
 *   Min ACU = 0 (true scale-to-zero / pause)
 *     The cluster pauses after inactivity. First query after pause takes
 *     5–15 s (cold start). For ingestion pipelines this is irrelevant.
 *     For interactive resume generation, set minAcu = 0.5 in config or
 *     add a keep-warm ping — this is a future concern, not day-one.
 *
 *   RDS Data API enabled
 *     Allows Lambda and custom-resource queries over HTTPS without
 *     requiring a VPC-aware Lambda or NAT gateway. Query Lambdas remain
 *     fully serverless (outside the VPC).
 *
 *   Isolated VPC (no NAT)
 *     Aurora requires a VPC. Isolated subnets only — no internet gateway,
 *     no NAT, no idle cost. VPC endpoints for AWS services can be added
 *     if direct pg connections (non-Data-API) are introduced later.
 *
 *   HNSW index (not IVFFlat)
 *     IVFFlat must be built on existing data (learns centroids). HNSW
 *     builds incrementally — correct for a dataset that starts empty and
 *     grows over time. m=16, ef_construction=64 are the pgvector defaults.
 *
 *   Schema bootstrapped at deploy time
 *     pgvector extension + document_embeddings table + indexes are
 *     created via chained AwsCustomResource calls against the Data API.
 *     Idempotent (IF NOT EXISTS) — safe on re-deploy.
 *
 * Cold-start timing note:
 *   AWS: "clusters with zero ACU pause within approximately 5 minutes
 *   of the last connection closing" (Aurora User Guide, 2024). Wake-up
 *   occurs on the next Data API or TCP connection attempt.
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

export interface AuroraPgVectorStackProps extends cdk.StackProps {
    /** Name prefix for all resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;

    /**
     * Minimum Aurora Capacity Units.
     *
     * Set to 0 for true scale-to-zero (cluster pauses after inactivity).
     * The AWS-enforced minimum is 0 — the CDK/CloudFormation default is 0.5
     * which still incurs cost. This must be set explicitly to 0.
     *
     * Set to 0.5 if cold-start latency is unacceptable for the use case.
     */
    readonly minAcu: number;

    /**
     * Maximum Aurora Capacity Units.
     *
     * Caps peak cost. Each ACU ≈ 2 GiB RAM + proportional CPU.
     * 4 ACUs is sufficient for portfolio-scale workloads (< 1M vectors).
     */
    readonly maxAcu: number;

    /**
     * PostgreSQL database name created on cluster init.
     * Used in Data API calls and pgvector schema bootstrap.
     */
    readonly databaseName: string;

    /**
     * Embedding vector dimension.
     * Must match the Bedrock embedding model output.
     *   - Titan Embed Text v2 (1024-dim): 1024
     *   - Titan Embed Text v1 (1536-dim): 1536
     *
     * The document_embeddings table schema is generated with this value.
     * Changing it after deploy requires a table drop-and-recreate.
     */
    readonly embeddingDimension: number;

    /** CloudWatch log retention for cluster activity logs */
    readonly logRetention: logs.RetentionDays;

    /** Removal policy — DESTROY for dev, RETAIN for production */
    readonly removalPolicy: cdk.RemovalPolicy;

    /** Runtime environment name (for resource tags and SSM paths) */
    readonly environmentName: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Aurora Serverless v2 PostgreSQL cluster with pgvector.
 *
 * Exposes the cluster ARN, secret ARN, endpoint address, port, DB name,
 * and VPC/security-group references so downstream stacks can wire Lambda
 * functions that query the vector store.
 */
export class AuroraPgVectorStack extends cdk.Stack {
    /** The Aurora cluster */
    public readonly cluster: rds.DatabaseCluster;

    /** Auto-generated Secrets Manager secret (username + password JSON) */
    public readonly secret: secretsmanager.ISecret;

    /** VPC hosting the cluster (for Lambda VPC placement if needed) */
    public readonly vpc: ec2.Vpc;

    /** Security group allowing inbound PostgreSQL (5432) from within the VPC */
    public readonly dbSecurityGroup: ec2.SecurityGroup;

    /** Cluster ARN — required for Data API calls */
    public readonly clusterArn: string;

    /** Secret ARN — required for Data API authentication */
    public readonly secretArn: string;

    /** Cluster writer endpoint address */
    public readonly clusterEndpointAddress: string;

    /** PostgreSQL port (always 5432) */
    public readonly clusterPort: number;

    /** Database name passed through for cross-stack reference */
    public readonly databaseName: string;

    constructor(scope: Construct, id: string, props: AuroraPgVectorStackProps) {
        super(scope, id, props);

        const { namePrefix, databaseName } = props;
        this.databaseName = databaseName;

        // =================================================================
        // VPC — Isolated subnets only, 2 AZs, zero NAT cost
        //
        // Aurora Serverless v2 requires a VPC with a DB subnet group
        // spanning at least 2 AZs. Isolated subnets have no internet
        // access — correct for a database that should never be reachable
        // from the public internet.
        //
        // VPC endpoints for AWS services (Secrets Manager, STS, etc.) are
        // NOT created here. If Lambdas placed inside this VPC need to call
        // AWS APIs, add interface endpoints or move them outside the VPC
        // and use the Data API instead (recommended).
        // =================================================================
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `${namePrefix}-pgvector`,
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'isolated',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        });

        // =================================================================
        // Security Group — PostgreSQL ingress from within the VPC
        //
        // Port 5432 is open to the VPC CIDR only. Direct TCP connections
        // (psycopg2, pg, prisma) require the Lambda to be in this VPC.
        // Data API connections do NOT use this security group — they are
        // routed through the managed Aurora Data API service.
        // =================================================================
        this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc: this.vpc,
            securityGroupName: `${namePrefix}-pgvector-db`,
            description: 'Aurora pgvector — allow PostgreSQL from within VPC',
            allowAllOutbound: false,
        });

        this.dbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(5432),
            'PostgreSQL from within VPC',
        );

        // =================================================================
        // Credentials — auto-generated password in Secrets Manager
        //
        // CDK generates a random password and stores it as a JSON secret:
        //   { "username": "pgvector_admin", "password": "<random>" }
        // The cluster reads the secret ARN from this credential object.
        // =================================================================
        const credentials = rds.Credentials.fromGeneratedSecret('pgvector_admin', {
            secretName: `${namePrefix}/aurora-pgvector/credentials`,
        });

        // =================================================================
        // Aurora Serverless v2 Cluster
        //
        // Engine: Aurora PostgreSQL 16.6
        //   - pgvector 0.8.0 included (available since Aurora PG 15.3+)
        //   - gen_random_uuid() is a built-in (no uuid-ossp needed)
        //   - Supports HNSW index type (pgvector 0.5.0+)
        //   - Supports min ACU 0 (pause) on PG 16.2+
        //
        // Min ACU 0: explicitly set — CDK/CFn default is 0.5 which incurs
        //   cost even when idle. Setting 0 enables the pause behaviour.
        //
        // Data API: enabled — allows HTTPS-based SQL execution from any
        //   Lambda/custom-resource without VPC placement or TCP connection.
        //   Required for the pgvector bootstrap custom resources below.
        // =================================================================
        this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
            clusterIdentifier: `${namePrefix}-pgvector`,
            engine: rds.DatabaseClusterEngine.auroraPostgres({
                version: rds.AuroraPostgresEngineVersion.VER_16_6,
            }),
            writer: rds.ClusterInstance.serverlessV2('writer'),
            serverlessV2MinCapacity: props.minAcu,
            serverlessV2MaxCapacity: props.maxAcu,
            credentials,
            defaultDatabaseName: databaseName,
            vpc: this.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [this.dbSecurityGroup],
            enableDataApi: true,
            backup: {
                // Minimum retention — 1 day is the Aurora minimum
                retention: cdk.Duration.days(1),
            },
            cloudwatchLogsExports: ['postgresql'],
            cloudwatchLogsRetention: props.logRetention,
            deletionProtection: props.removalPolicy === cdk.RemovalPolicy.RETAIN,
            removalPolicy: props.removalPolicy,
            storageEncrypted: true,
        });

        // Resolve the generated secret — guaranteed non-null after fromGeneratedSecret
        this.secret = this.cluster.secret!;
        this.clusterArn = this.cluster.clusterArn;
        this.secretArn = this.secret.secretArn;
        this.clusterEndpointAddress = this.cluster.clusterEndpoint.hostname;
        this.clusterPort = this.cluster.clusterEndpoint.port;

        // =================================================================
        // CDK-Nag suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.cluster,
            [
                {
                    id: 'AwsSolutions-RDS6',
                    reason: 'IAM DB authentication not used — Data API with Secrets Manager provides equivalent security',
                },
                {
                    id: 'AwsSolutions-RDS10',
                    reason: 'Deletion protection is set dynamically via removalPolicy — RETAIN envs enable it above',
                },
                {
                    id: 'AwsSolutions-RDS11',
                    reason: 'Default PostgreSQL port 5432 used — non-standard port provides no meaningful security benefit',
                },
            ],
            true,
        );

        // =================================================================
        // Shared IAM policy for Data API bootstrap custom resources
        //
        // Both the extension-init and schema-init custom resources share
        // the same permissions. CDK's AwsCustomResource creates a singleton
        // Lambda per policy — reuse it by sharing the same policy object.
        // =================================================================
        const dataApiPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                sid: 'AllowDataApiExecute',
                actions: ['rds-data:ExecuteStatement'],
                resources: [this.cluster.clusterArn],
            }),
            new iam.PolicyStatement({
                sid: 'AllowSecretRead',
                actions: ['secretsmanager:GetSecretValue'],
                resources: [this.secret.secretArn],
            }),
        ]);

        // Helper to build a Data API AwsCustomResource for a single DDL statement
        const ddlStep = (
            id: string,
            label: string,
            sql: string,
        ): cr.AwsCustomResource => {
            return new cr.AwsCustomResource(this, id, {
                installLatestAwsSdk: false,
                logRetention: props.logRetention,
                onCreate: {
                    service: 'RDSDataService',
                    action: 'executeStatement',
                    parameters: {
                        resourceArn: this.cluster.clusterArn,
                        secretArn: this.secret.secretArn,
                        database: databaseName,
                        sql,
                    },
                    physicalResourceId: cr.PhysicalResourceId.of(
                        `${namePrefix}-${label}`,
                    ),
                },
                policy: dataApiPolicy,
            });
        };

        // =================================================================
        // Schema Bootstrap — chained DDL steps via Data API
        //
        // Executed once at stack creation (onCreate only — idempotent via
        // IF NOT EXISTS). Each step depends on the previous so CloudFormation
        // applies them in order.
        //
        // IMPORTANT: executeStatement supports exactly ONE SQL statement per
        // call. Multi-statement strings throw BadRequestException. Each DDL
        // operation is its own AwsCustomResource, chained via addDependency.
        //
        // Step 1: pgvector extension
        // Step 2: document_embeddings table (chunk-aware, repo-scoped)
        // Step 3: repo_sync_state table (per-user/repo ingestion tracking)
        // Step 4: b-tree index on user_id
        // Step 5: composite b-tree index on (user_id, repo_full_name)
        // Step 6: unique index on (user_id, repo_full_name, file_path, chunk_index) — enables ON CONFLICT upsert
        // Step 7: HNSW index on the embedding column
        //
        // Why HNSW over IVFFlat:
        //   IVFFlat requires a full dataset scan to build cluster centroids
        //   (typically `VACUUM ANALYZE` + `CREATE INDEX` after data load).
        //   HNSW inserts each vector into the graph at write time — correct
        //   for a table that starts empty and is populated incrementally.
        //   Trade-off: HNSW uses more memory (~8 bytes × m × vectors) but
        //   for a portfolio KB (< 50K vectors) this is negligible.
        //
        // content_hash usage:
        //   Ingestion Lambda checks `WHERE content_hash = $1 AND user_id = $2`
        //   before calling Titan Embed — skips re-embedding unchanged chunks.
        //   Hash is SHA-256 of the raw chunk text.
        //
        // Table schema note:
        //   embedding column is vector(N) where N = props.embeddingDimension.
        //   Changing the dimension after creation requires:
        //     DROP INDEX idx_embeddings_hnsw;
        //     ALTER TABLE document_embeddings DROP COLUMN embedding;
        //     ALTER TABLE document_embeddings ADD COLUMN embedding vector(NEW_DIM);
        //   The stack must be destroyed and recreated to change the dimension.
        // =================================================================

        // Step 1 — pgvector extension
        const step1 = ddlStep(
            'InitExtension',
            'init-extension',
            'CREATE EXTENSION IF NOT EXISTS vector;',
        );
        step1.node.addDependency(this.cluster);

        // Step 2 — document_embeddings table (chunk-level, repo-scoped)
        //   repo_full_name: "owner/repo" format (e.g. "nelsonlamounier/portfolio")
        //   file_path: relative path within the repo (e.g. "src/app/page.tsx")
        //   heading: extracted markdown/code heading for the chunk (nullable)
        //   file_type: "md" | "ts" | "py" etc. (nullable — for future filtering)
        //   tags: free-form text tags array (nullable)
        //   chunk_index / total_chunks: position within the parent file
        //   content_hash: SHA-256 of chunk text — used to skip re-embedding
        //   last_synced_at: timestamp of most recent ingestion for this chunk
        const step2 = ddlStep(
            'InitEmbeddingsTable',
            'init-embeddings-table',
            `CREATE TABLE IF NOT EXISTS document_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  heading         TEXT,
  content         TEXT        NOT NULL,
  file_type       TEXT,
  tags            TEXT[],
  chunk_index     INTEGER     NOT NULL,
  total_chunks    INTEGER     NOT NULL,
  content_hash    TEXT        NOT NULL,
  embedding       vector(${props.embeddingDimension}) NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
        );
        step2.node.addDependency(step1);

        // Step 3 — repo_sync_state table (per-user/repo ingestion tracking)
        //   sync_status: "pending" | "syncing" | "complete" | "error"
        //   error_message: last error if sync_status = "error"
        //   file_count / chunk_count: totals from last successful sync
        const step3 = ddlStep(
            'InitSyncStateTable',
            'init-sync-state-table',
            `CREATE TABLE IF NOT EXISTS repo_sync_state (
  user_id         TEXT        NOT NULL,
  repo_full_name  TEXT        NOT NULL,
  sync_status     TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at  TIMESTAMPTZ,
  file_count      INTEGER     NOT NULL DEFAULT 0,
  chunk_count     INTEGER     NOT NULL DEFAULT 0,
  error_message   TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);`,
        );
        step3.node.addDependency(step2);

        // Step 4 — b-tree index on user_id for single-tenant pre-filtering
        //   Queries: WHERE user_id = $1 ORDER BY embedding <=> $2 LIMIT k
        const step4 = ddlStep(
            'InitUserIdIndex',
            'init-user-id-index',
            'CREATE INDEX IF NOT EXISTS idx_embeddings_user_id ON document_embeddings (user_id);',
        );
        step4.node.addDependency(step3);

        // Step 5 — composite index on (user_id, repo_full_name) for repo-scoped search
        //   Queries: WHERE user_id = $1 AND repo_full_name = $2 ORDER BY embedding <=> $3
        const step5 = ddlStep(
            'InitUserRepoIndex',
            'init-user-repo-index',
            'CREATE INDEX IF NOT EXISTS idx_embeddings_user_repo ON document_embeddings (user_id, repo_full_name);',
        );
        step5.node.addDependency(step4);

        // Step 6 — unique index on natural key for upsert (ON CONFLICT) support
        //   Each chunk is uniquely identified by (user_id, repo_full_name, file_path, chunk_index).
        //   A unique index (not UNIQUE CONSTRAINT) is used so we can create it with
        //   IF NOT EXISTS — making bootstrap idempotent on re-deploy.
        //   ON CONFLICT (...) DO UPDATE requires exactly this index to exist.
        const step6 = ddlStep(
            'InitNaturalKeyIndex',
            'init-natural-key-index',
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_natural_key
  ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);`,
        );
        step6.node.addDependency(step5);

        // Step 7 — HNSW index for approximate nearest-neighbour search
        //   cosine distance (vector_cosine_ops) matches Titan Embed v2 output
        //   m=16 (connections per layer), ef_construction=64 (build-time beam width)
        //   Must be the last step — table and b-tree indexes must exist first.
        const step7 = ddlStep(
            'InitHnswIndex',
            'init-hnsw-index',
            `CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
  ON document_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);`,
        );
        step7.node.addDependency(step6);

        // Suppress CDK-Nag on the singleton custom-resource Lambda runtime
        // (AWS679f53fac002430cb0da5b7982bd2287 — runtime managed by CDK framework)
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [{ id: 'AwsSolutions-L1', reason: 'Runtime managed by CDK AwsCustomResource singleton — cannot override' }],
        );

        // =================================================================
        // SSM Parameter Exports
        //
        // Published at paths Lambda environment variables can reference via
        // SSM resolution or direct string substitution in CDK.
        //
        // Aurora does not export CloudFormation outputs for endpoints
        // automatically — SSM is the cross-stack discovery mechanism.
        // =================================================================
        const ssmBase = `/${namePrefix}/pgvector`;

        new ssm.StringParameter(this, 'SsmClusterArn', {
            parameterName: `${ssmBase}/cluster-arn`,
            stringValue: this.cluster.clusterArn,
            description: `Aurora pgvector cluster ARN (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmSecretArn', {
            parameterName: `${ssmBase}/secret-arn`,
            stringValue: this.secret.secretArn,
            description: `Aurora pgvector credentials secret ARN (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmEndpoint', {
            parameterName: `${ssmBase}/endpoint`,
            stringValue: this.cluster.clusterEndpoint.hostname,
            description: `Aurora pgvector writer endpoint (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmPort', {
            parameterName: `${ssmBase}/port`,
            stringValue: this.cluster.clusterEndpoint.port.toString(),
            description: `Aurora pgvector port (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmDatabase', {
            parameterName: `${ssmBase}/database`,
            stringValue: databaseName,
            description: `Aurora pgvector database name (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmVpcId', {
            parameterName: `${ssmBase}/vpc-id`,
            stringValue: this.vpc.vpcId,
            description: `Aurora pgvector VPC ID (${namePrefix}) — needed for Lambda VPC placement`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmDbSgId', {
            parameterName: `${ssmBase}/db-sg-id`,
            stringValue: this.dbSecurityGroup.securityGroupId,
            description: `Aurora pgvector DB security group ID (${namePrefix})`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // CloudFormation Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ClusterArn', {
            value: this.cluster.clusterArn,
            description: 'Aurora pgvector cluster ARN',
            exportName: `${namePrefix}-pgvector-cluster-arn`,
        });

        new cdk.CfnOutput(this, 'SecretArn', {
            value: this.secret.secretArn,
            description: 'Aurora pgvector credentials secret ARN',
            exportName: `${namePrefix}-pgvector-secret-arn`,
        });

        new cdk.CfnOutput(this, 'ClusterEndpoint', {
            value: this.cluster.clusterEndpoint.hostname,
            description: 'Aurora pgvector writer endpoint',
        });

        new cdk.CfnOutput(this, 'EmbeddingDimension', {
            value: props.embeddingDimension.toString(),
            description: `pgvector embedding dimension — must match Bedrock embedding model`,
        });
    }
}
