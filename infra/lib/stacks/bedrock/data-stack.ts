/**
 * @format
 * Bedrock Data Stack
 *
 * Stateful resources for the Bedrock Agent project.
 * Owns the S3 bucket used as a Knowledge Base data source.
 *
 * Lifecycle: independent of Agent/API stacks — data persists across
 * agent redeployments.
 */

import { NagSuppressions } from 'cdk-nag';

import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import type { Construct } from 'constructs';

import { ApplicationInferenceProfile } from '../../constructs/observability/application-inference-profile';

/**
 * CORS rules shared by AssetsBucket and ArticleAssetsBucket — both allow
 * browser-direct PUT (presigned URL) / GET / HEAD from the same set of
 * Tucaken origins. Kept as a single source of truth so the two buckets
 * cannot silently drift apart.
 */
const BUCKET_CORS_RULES: s3.CorsRule[] = [
    {
        allowedOrigins: [
            'http://localhost:5001',
            'https://tucaken.io',
            'https://www.tucaken.io',
            'https://tucaken.com',
            'https://www.tucaken.com',
        ],
        allowedMethods: [
            s3.HttpMethods.PUT,
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
        ],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3000,
    },
];

/**
 * Props for BedrockDataStack
 */
export interface BedrockDataStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Whether to create a customer-managed KMS key for S3 encryption */
    readonly createEncryptionKey: boolean;
    /** Removal policy for the S3 bucket */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** System inference profile ARN for Haiku 4.5 (used as CopyFrom source) */
    readonly haikuProfileSourceArn: string;
    /** System inference profile ARN for Sonnet 4.6 (used as CopyFrom source) */
    readonly sonnetProfileSourceArn: string;
    /** Runtime environment name (for profile tags) */
    readonly environmentName: string;
    /** IAM role NAME (not ARN) of admin-api's runtime role — granted put/delete on article assets. */
    readonly articleAssetsAdminRoleName: string;
    /** IAM role NAME of public-api's runtime role — granted read on images/articles/*. */
    readonly articleAssetsReaderRoleName: string;
    /**
     * Email address to notify when the Bedrock monthly spend reaches budget thresholds.
     *
     * When provided, creates a `CfnBudget` that fires at 80 % and 100 % of
     * `monthlyBudgetUsd`. Notifications use AWS Budgets built-in email delivery
     * (no SNS topic needed).
     *
     * @default undefined — no budget alarm created
     */
    readonly budgetAlertEmail?: string;
    /**
     * Monthly Bedrock spend limit in USD.
     *
     * @default 20
     */
    readonly monthlyBudgetUsd?: number;
}

/**
 * Data Stack for Bedrock Agent.
 *
 * Creates the S3 bucket that serves as the data source for the
 * Bedrock Knowledge Base. Publishes bucket identifiers to SSM
 * for cross-stack discovery.
 */
export class BedrockDataStack extends cdk.Stack {
    /** The S3 bucket for Knowledge Base documents */
    public readonly dataBucket: s3.Bucket;

    /** The S3 bucket for user-uploaded resume files (presigned PUT) */
    public readonly assetsBucket: s3.IBucket;

    /** Public article media (images/videos) served via public-api. NO PII ever lands here. */
    public readonly articleAssetsBucket: s3.Bucket;

    /** S3 bucket for server access logs */
    public readonly accessLogsBucket: s3.Bucket;

    /** Optional KMS encryption key (production only) */
    public readonly encryptionKey?: kms.Key;

    /** The bucket name (for SSM export) */
    public readonly bucketName: string;

    /** SM secret name the ingestion ESO ExternalSecret reads (GITHUB_TOKEN) */
    public readonly ingestionGithubTokenSecretName: string;

    /** Application Inference Profile ARN — Article Pipeline Haiku 4.5 */
    public readonly articleHaikuProfileArn: string;
    /** Application Inference Profile ARN — Article Pipeline Sonnet 4.6 */
    public readonly articleSonnetProfileArn: string;
    /** Application Inference Profile ARN — Strategist Pipeline Haiku 4.5 */
    public readonly strategistHaikuProfileArn: string;
    /** Application Inference Profile ARN — Strategist Pipeline Sonnet 4.6 */
    public readonly strategistSonnetProfileArn: string;

    constructor(scope: Construct, id: string, props: BedrockDataStackProps) {
        super(scope, id, props);

        const { namePrefix, createEncryptionKey, removalPolicy } = props;

        // =================================================================
        // KMS Encryption Key (production only)
        // =================================================================
        if (createEncryptionKey) {
            this.encryptionKey = new kms.Key(this, 'DataBucketKey', {
                alias: `${namePrefix}-data-bucket`,
                description: `KMS key for ${namePrefix} Knowledge Base data bucket`,
                enableKeyRotation: true,
                removalPolicy,
            });
        }

        // =================================================================
        // S3 Bucket — Access Logs (required by AwsSolutions-S1)
        // =================================================================
        this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
            bucketName: `${namePrefix}-access-logs`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(90),
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(30),
                        },
                    ],
                },
            ],
        });

        // =================================================================
        // S3 Bucket — Knowledge Base Data Source
        // =================================================================
        this.dataBucket = new s3.Bucket(this, 'DataBucket', {
            bucketName: `${namePrefix}-kb-data`,
            encryption: this.encryptionKey
                ? s3.BucketEncryption.KMS
                : s3.BucketEncryption.S3_MANAGED,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: this.accessLogsBucket,
            serverAccessLogsPrefix: 'data-bucket/',
        });
        this.bucketName = this.dataBucket.bucketName;

        // =================================================================
        // S3 Bucket — Resume Upload Assets
        //
        // Stores PDF/DOCX files uploaded by users before the K8s Job
        // processes them. Name is CDK-generated (no hardcoded string) to
        // guarantee global uniqueness. CORS allows browser-direct PUT via
        // presigned URL from all allowed origins.
        // =================================================================
        this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: this.accessLogsBucket,
            serverAccessLogsPrefix: 'assets-bucket/',
            cors: BUCKET_CORS_RULES,
        });

        // =================================================================
        // Article assets bucket — public-content media only.
        //
        // Deliberately separate from AssetsBucket (resumes/, resume-imports/
        // = user PII): public-api's internet-facing image endpoint reads
        // from here, and bucket-level separation makes PII exposure
        // structurally impossible rather than policy-guarded.
        // =================================================================
        this.articleAssetsBucket = new s3.Bucket(this, 'ArticleAssetsBucket', {
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
            serverAccessLogsBucket: this.accessLogsBucket,
            serverAccessLogsPrefix: 'article-assets-bucket/',
            cors: BUCKET_CORS_RULES,
        });

        const articleAdminRole = iam.Role.fromRoleName(
            this,
            'ArticleAssetsAdminRole',
            props.articleAssetsAdminRoleName,
        );
        const articleReaderRole = iam.Role.fromRoleName(
            this,
            'ArticleAssetsReaderRole',
            props.articleAssetsReaderRoleName,
        );

        articleAdminRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:DeleteObject'],
            resources: [
                this.articleAssetsBucket.arnForObjects('images/articles/*'),
                this.articleAssetsBucket.arnForObjects('videos/articles/*'),
            ],
        }));
        articleReaderRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [this.articleAssetsBucket.arnForObjects('images/articles/*')],
        }));

        // =================================================================
        // Ingestion GitHub token — IaC ownership of the SM secret that the
        // ingestion-worker Jobs consume via ESO (kubernetes-bootstrap
        // charts/ingestion/external-secrets/ingestion-secrets.yaml maps it
        // to the GITHUB_TOKEN env var).
        //
        // secretName is the LITERAL legacy path the ExternalSecret remoteRef
        // expects — intentionally NOT `${namePrefix}/…`: the removed legacy
        // CDK IngestionStack used the full-env prefix ('bedrock-development')
        // whereas namePrefix here is short-env ('bedrock-dev'). Renaming
        // would also require editing the kubernetes-bootstrap ExternalSecret
        // + an ESO re-sync, so the literal name is kept here.
        //
        // CDK owns the resource (name, RETAIN lifecycle, IAM surface). The
        // PAT *value* is a third-party credential and is injected
        // out-of-band (never in source / CloudFormation) — see the cutover
        // runbook. No generateSecretString (a real GitHub PAT cannot be
        // synthesised); no rotation (manual external credential).
        // =================================================================
        const ingestionGithubToken = new secretsmanager.Secret(this, 'IngestionGithubTokenSecret', {
            secretName: 'bedrock-development/github-token',
            description:
                'GitHub PAT consumed by ingestion-worker Jobs via ESO '
                + '(ingestion-secrets → GITHUB_TOKEN). Value injected post-deploy.',
        });
        // A credential must survive `cdk destroy`; never auto-delete.
        ingestionGithubToken.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
        NagSuppressions.addResourceSuppressions(ingestionGithubToken, [
            {
                id: 'AwsSolutions-SMG4',
                reason:
                    'GitHub PAT is an externally-issued third-party credential injected '
                    + 'out-of-band; Secrets Manager cannot mint/rotate a GitHub token. '
                    + 'Rotated manually on PAT expiry (mirrors AgentApiKeySecret rationale).',
            },
        ]);
        this.ingestionGithubTokenSecretName = ingestionGithubToken.secretName;

        new cdk.CfnOutput(this, 'IngestionGithubTokenSecretName', {
            value: ingestionGithubToken.secretName,
            description: 'SM secret name the ingestion ESO ExternalSecret reads',
        });

        // =================================================================
        // Application Inference Profiles — FinOps Cost Attribution
        //
        // Each profile wraps a system-defined inference profile with
        // cost-allocation tags, enabling per-pipeline billing in
        // AWS Cost Explorer.
        // =================================================================
        const profileTags = (component: string): cdk.CfnTag[] => [
            { key: 'project', value: 'bedrock' },
            { key: 'cost-centre', value: 'application' },
            { key: 'component', value: component },
            { key: 'environment', value: props.environmentName },
            { key: 'owner', value: 'nelson-l' },
            { key: 'managed-by', value: 'cdk' },
        ];

        const articleHaikuProfile = new ApplicationInferenceProfile(this, 'ArticleHaikuProfile', {
            profileName: `${namePrefix}-article-haiku`,
            modelSourceArn: props.haikuProfileSourceArn,
            description: 'Article pipeline research agent Haiku 4.5',
            tags: profileTags('article-pipeline'),
        });
        this.articleHaikuProfileArn = articleHaikuProfile.profileArn;

        const articleSonnetProfile = new ApplicationInferenceProfile(this, 'ArticleSonnetProfile', {
            profileName: `${namePrefix}-article-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Article pipeline writer and QA agents Sonnet 4.6',
            tags: profileTags('article-pipeline'),
        });
        this.articleSonnetProfileArn = articleSonnetProfile.profileArn;

        const strategistHaikuProfile = new ApplicationInferenceProfile(this, 'StrategistHaikuProfile', {
            profileName: `${namePrefix}-strategist-haiku`,
            modelSourceArn: props.haikuProfileSourceArn,
            description: 'Strategist pipeline research resume builder and coach Haiku 4.5',
            tags: profileTags('strategist'),
        });
        this.strategistHaikuProfileArn = strategistHaikuProfile.profileArn;

        const strategistSonnetProfile = new ApplicationInferenceProfile(this, 'StrategistSonnetProfile', {
            profileName: `${namePrefix}-strategist-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Strategist pipeline writer agent Sonnet 4.6',
            tags: profileTags('strategist'),
        });
        this.strategistSonnetProfileArn = strategistSonnetProfile.profileArn;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'BucketNameParam', {
            parameterName: `/${namePrefix}/data-bucket-name`,
            stringValue: this.dataBucket.bucketName,
            description: `Knowledge Base data bucket name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AssetsBucketNameParam', {
            parameterName: `/${namePrefix}/assets-bucket-name`,
            stringValue: this.assetsBucket.bucketName,
            description: `Resume upload assets bucket name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ArticleAssetsBucketNameParam', {
            parameterName: `/${namePrefix}/article-assets-bucket-name`,
            stringValue: this.articleAssetsBucket.bucketName,
            description: `Public article media bucket for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'BucketArnParam', {
            parameterName: `/${namePrefix}/data-bucket-arn`,
            stringValue: this.dataBucket.bucketArn,
            description: `Knowledge Base data bucket ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ArticleHaikuProfileArnParam', {
            parameterName: `/${namePrefix}/article-haiku-profile-arn`,
            stringValue: this.articleHaikuProfileArn,
            description: `Article pipeline Haiku 4.5 inference profile ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ArticleSonnetProfileArnParam', {
            parameterName: `/${namePrefix}/article-sonnet-profile-arn`,
            stringValue: this.articleSonnetProfileArn,
            description: `Article pipeline Sonnet 4.6 inference profile ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'StrategistHaikuProfileArnParam', {
            parameterName: `/${namePrefix}/strategist-haiku-profile-arn`,
            stringValue: this.strategistHaikuProfileArn,
            description: `Strategist pipeline Haiku 4.5 inference profile ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'StrategistSonnetProfileArnParam', {
            parameterName: `/${namePrefix}/strategist-sonnet-profile-arn`,
            stringValue: this.strategistSonnetProfileArn,
            description: `Strategist pipeline Sonnet 4.6 inference profile ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Monthly Budget Alarm — FinOps Guardrail (Gap C3)
        //
        // Creates an AWS Budgets cost alert scoped to the Amazon Bedrock
        // service. Fires SNS email notifications at 80 % (FORECASTED) and
        // 100 % (ACTUAL) of the monthly limit so spend spikes are caught
        // before the period ends.
        //
        // Only created when budgetAlertEmail is provided — omit in local/test
        // stacks to avoid stray budget resources.
        // =================================================================
        if (props.budgetAlertEmail) {
            const budgetAmountUsd = props.monthlyBudgetUsd ?? 20;

            new budgets.CfnBudget(this, 'BedrockMonthlyBudget', {
                budget: {
                    budgetName: `${namePrefix}-bedrock-monthly`,
                    budgetType: 'COST',
                    timeUnit: 'MONTHLY',
                    budgetLimit: {
                        amount: budgetAmountUsd,
                        unit: 'USD',
                    },
                    costFilters: {
                        // Scope to Bedrock service costs only
                        Service: ['Amazon Bedrock'],
                    },
                },
                notificationsWithSubscribers: [
                    {
                        notification: {
                            comparisonOperator: 'GREATER_THAN',
                            notificationType: 'FORECASTED',
                            threshold: 80,
                            thresholdType: 'PERCENTAGE',
                        },
                        subscribers: [{
                            address: props.budgetAlertEmail,
                            subscriptionType: 'EMAIL',
                        }],
                    },
                    {
                        notification: {
                            comparisonOperator: 'GREATER_THAN',
                            notificationType: 'ACTUAL',
                            threshold: 100,
                            thresholdType: 'PERCENTAGE',
                        },
                        subscribers: [{
                            address: props.budgetAlertEmail,
                            subscriptionType: 'EMAIL',
                        }],
                    },
                ],
            });
        }

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'DataBucketName', {
            value: this.dataBucket.bucketName,
            description: 'Knowledge Base data bucket name',
        });

        new cdk.CfnOutput(this, 'DataBucketArn', {
            value: this.dataBucket.bucketArn,
            description: 'Knowledge Base data bucket ARN',
        });

        new cdk.CfnOutput(this, 'AccessLogsBucketName', {
            value: this.accessLogsBucket.bucketName,
            description: 'Server access logs bucket name',
        });

        // ─── OAuth token envelope encryption ──────────────────────────────────
        // Dedicated CMK for oauth_connections.access_token envelope encryption
        // (per PR-1 design). The key policy is left at AWS default (root-only);
        // the EKS node IAM role is granted Encrypt/Decrypt/GenerateDataKey out
        // of band — see docs/superpowers/specs/2026-05-20-oauth-app-revocation-
        // foundation-design.md for the deploy runbook.
        const oauthTokenKey = new kms.Key(this, 'OAuthTokenKey', {
            alias: 'alias/oauth-token-encryption',
            description: 'Envelope encryption for oauth_connections.access_token',
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            pendingWindow: cdk.Duration.days(30),
        });

        new ssm.StringParameter(this, 'OAuthTokenKeyArnParam', {
            parameterName: '/oauth/token-encryption-key-arn',
            stringValue: oauthTokenKey.keyArn,
            description: 'KMS CMK ARN for oauth_connections token envelope encryption',
        });

        new cdk.CfnOutput(this, 'OAuthTokenKeyArn', {
            value: oauthTokenKey.keyArn,
            description: 'KMS CMK ARN for oauth_connections token envelope encryption',
            exportName: `${props.namePrefix}-OAuthTokenKeyArn`,
        });
    }
}
