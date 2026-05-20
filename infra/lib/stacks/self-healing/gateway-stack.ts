/**
 * @format
 * Self-Healing Gateway Stack
 *
 * Creates the AgentCore Gateway using the official L2 construct from
 * `@aws-cdk/aws-bedrock-agentcore-alpha`. The Gateway acts as the central
 * MCP-compatible tool discovery and invocation layer for the Self-Healing
 * Agent in the companion AgentStack.
 *
 * Resources:
 * - AgentCore Gateway (L2 construct — CloudFormation-managed lifecycle)
 * - Default Cognito authoriser for M2M (machine-to-machine) JWT auth
 * - 5 Lambda tool functions registered as MCP targets:
 *   1. diagnose-alarm
 *   2. check-node-health
 *   3. analyse-cluster-health
 *   4. get-node-diagnostic-json
 *   5. remediate-node-bootstrap
 * - SSM parameters for cross-stack discovery
 * - CloudWatch log group for Gateway invocations
 *
 * The L2 construct automatically provisions:
 * - IAM role for tool invocation (no manual role required)
 * - Cognito User Pool + Client for OAuth 2.0 client credentials flow
 * - MCP protocol configuration (MCP 2025-03-26, SEMANTIC search)
 */

import * as path from 'node:path';

import {
    Gateway,
    ToolSchema,
    SchemaDefinitionType,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import type { Construct } from 'constructs';

import { ApplicationInferenceProfile } from '../../constructs/observability/application-inference-profile';
import { addLambdaObservabilityToAll, OBSERVABILITY_EXTERNAL_MODULES } from '../../utilities/lambda-observability';


/**
 * Props for SelfHealingGatewayStack
 */
export interface SelfHealingGatewayStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'self-healing-dev') */
    readonly namePrefix: string;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
    /** System inference profile ARN for Sonnet 4.6 (used as CopyFrom source) */
    readonly sonnetProfileSourceArn: string;
    /** Runtime environment name (for profile tags) */
    readonly environmentName: string;
    /**
     * SSM Parameter Store path for the Step Functions bootstrap orchestrator ARN.
     * The ARN is resolved within the Stack constructor using
     * `StringParameter.valueForStringParameter`, emitting a CloudFormation
     * dynamic reference. Set by `K8sSsmAutomationStack` at deploy time.
     * Example: `/k8s/development/bootstrap/state-machine-arn`
     */
    readonly stateMachineArnSsmPath: string;
}

/**
 * Gateway Stack for Self-Healing Pipeline.
 *
 * Creates an AgentCore Gateway using the official L2 construct and
 * registers tool Lambda functions as MCP-compatible tools accessible
 * to the Bedrock ConverseCommand agent.
 */
export class SelfHealingGatewayStack extends cdk.Stack {
    /** The AgentCore Gateway L2 construct */
    public readonly gateway: Gateway;

    /** The Gateway URL endpoint */
    public readonly gatewayUrl: string;

    /** The Gateway unique identifier */
    public readonly gatewayId: string;

    /** Cognito OAuth2 token endpoint for client credentials flow */
    public readonly tokenEndpointUrl: string;

    /** Cognito User Pool ID (needed to retrieve client secret at runtime) */
    public readonly userPoolId: string;

    /** Cognito User Pool Client ID for M2M auth */
    public readonly userPoolClientId: string;

    /** OAuth2 scope strings for client credentials flow */
    public readonly oauthScopes: string;

    /** Application Inference Profile ARN — Self-Healing Agent Sonnet 4.6 */
    public readonly agentProfileArn: string;

    constructor(scope: Construct, id: string, props: SelfHealingGatewayStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Resolve the Step Functions bootstrap orchestrator ARN.
        //
        // valueForStringParameter must be called on a Stack scope (this),
        // not on the App. It emits {{resolve:ssm:...}} CloudFormation token
        // resolved at deploy time — no synth-time AWS call needed.
        // =================================================================
        const stateMachineArn = ssm.StringParameter.valueForStringParameter(
            this,
            props.stateMachineArnSsmPath,
        );

        // =================================================================
        // CloudWatch Log Group — Gateway invocations
        // =================================================================
        new logs.LogGroup(this, 'GatewayLogGroup', {
            logGroupName: `/aws/agentcore/${namePrefix}-gateway`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // AgentCore Gateway — L2 Construct
        //
        // Creates a fully CloudFormation-managed MCP Gateway with:
        // - Auto-generated IAM role for Lambda tool invocation
        // - Default Cognito authoriser (M2M client credentials flow)
        // - MCP protocol v2025-03-26 with SEMANTIC search
        // =================================================================
        this.gateway = new Gateway(this, 'Gateway', {
            gatewayName: `${namePrefix}-gateway`,
            description: `Self-healing MCP tool gateway for ${namePrefix}`,
        });

        // Expose gateway URL and ID — populated by CloudFormation after deploy
        this.gatewayUrl = this.gateway.gatewayUrl ?? `https://${namePrefix}-gateway.bedrock.${this.region}.amazonaws.com`;
        this.gatewayId = this.gateway.gatewayId;

        // Expose Cognito auth details for the Agent Lambda
        this.tokenEndpointUrl = this.gateway.tokenEndpointUrl ?? '';
        this.userPoolId = this.gateway.userPool?.userPoolId ?? '';
        this.userPoolClientId = this.gateway.userPoolClient?.userPoolClientId ?? '';
        this.oauthScopes = (this.gateway.oauthScopes ?? []).join(' ');

        // =================================================================
        // Tool Lambda 1: Diagnose Alarm
        //
        // Queries CloudWatch for alarm configuration, current state,
        // and recent metric datapoints. Returns a structured diagnostic
        // report that helps the agent understand what went wrong.
        // =================================================================
        const diagnoseAlarmFn = new lambdaNode.NodejsFunction(this, 'DiagnoseAlarmFunction', {
            functionName: `${namePrefix}-tool-diagnose-alarm`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'diagnose-alarm', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'DiagnoseAlarmLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-diagnose-alarm`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: diagnose CloudWatch alarms for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Grant CloudWatch read access for alarm diagnosis
        diagnoseAlarmFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ReadCloudWatchAlarms',
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:DescribeAlarms',
                'cloudwatch:GetMetricData',
            ],
            resources: ['*'],
        }));


        // =================================================================
        // Tool Lambda 3: Check Node Health
        //
        // Runs `kubectl get nodes -o json` on the control plane node via
        // SSM SendCommand and returns a structured node health report.
        // Enables the agent to verify worker nodes joined the cluster.
        // =================================================================
        const checkNodeHealthFn = new lambdaNode.NodejsFunction(this, 'CheckNodeHealthFunction', {
            functionName: `${namePrefix}-tool-check-node-health`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'check-node-health', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            logGroup: new logs.LogGroup(this, 'CheckNodeHealthLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-node-health`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: check K8s node health via SSM for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Grant EC2 read access (resolve control plane instance by tag)
        checkNodeHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // Grant SSM SendCommand + GetCommandInvocation (run kubectl on CP node)
        // SH-S2: Scoped with tag-based condition — only targets k8s-tagged instances
        checkNodeHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
            ],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: {
                StringEquals: {
                    'ssm:resourceTag/Project': 'kubernetes',
                },
            },
        }));
        checkNodeHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 4: Analyse Cluster Health (K8sGPT)
        //
        // Runs K8sGPT on the control plane via SSM to diagnose workload
        // issues (failing pods, misconfigured services, etc.).
        // Falls back to kubectl if K8sGPT is not installed.
        // =================================================================
        const analyseClusterHealthFn = new lambdaNode.NodejsFunction(this, 'AnalyseClusterHealthFunction', {
            functionName: `${namePrefix}-tool-analyse-cluster-health`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'analyse-cluster-health', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(90),
            logGroup: new logs.LogGroup(this, 'AnalyseClusterHealthLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-analyse-cluster-health`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: K8sGPT cluster health analysis for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Grant EC2 read access (resolve control plane instance by tag)
        analyseClusterHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // Grant SSM SendCommand + GetCommandInvocation (run k8sgpt/kubectl on CP node)
        // SH-S2: Scoped with tag-based condition — only targets k8s-tagged instances
        analyseClusterHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
            ],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: {
                StringEquals: {
                    'ssm:resourceTag/Project': 'kubernetes',
                },
            },
        }));
        analyseClusterHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 5: Get Node Diagnostic JSON
        //
        // Fetches the machine-readable `run_summary.json` from a K8s node
        // via SSM SendCommand. Contains bootstrap status, failure
        // classification, and per-step timing from the Python StepRunner.
        // =================================================================
        const getNodeDiagnosticFn = new lambdaNode.NodejsFunction(this, 'GetNodeDiagnosticFunction', {
            functionName: `${namePrefix}-tool-get-node-diagnostic`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'get-node-diagnostic-json', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'GetNodeDiagnosticLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-get-node-diagnostic`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: fetch bootstrap run_summary.json from node for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Grant SSM SendCommand + GetCommandInvocation to read diagnostic file
        // SH-S2: Scoped with tag-based condition — only targets k8s-tagged instances
        getNodeDiagnosticFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
            ],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: {
                StringEquals: {
                    'ssm:resourceTag/Project': 'kubernetes',
                },
            },
        }));
        getNodeDiagnosticFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 6: Remediate Node Bootstrap
        //
        // Triggers an SSM Automation Document to re-run the bootstrap
        // sequence on a failed K8s node. Resolves Document names and
        // IAM roles from SSM Parameter Store at runtime.
        // =================================================================
        const remediateNodeBootstrapFn = new lambdaNode.NodejsFunction(this, 'RemediateNodeBootstrapFunction', {
            functionName: `${namePrefix}-tool-remediate-bootstrap`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'remediate-node-bootstrap', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'RemediateNodeBootstrapLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-remediate-bootstrap`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: trigger Step Functions bootstrap orchestrator for ${namePrefix}`,
            environment: {
                SSM_PREFIX: '/k8s/development',
                // Injected at deploy time from SSM — avoids runtime parameter lookup
                STATE_MACHINE_ARN: stateMachineArn,
            },
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Resolve the real ASG name for a given instance ID (avoids convention guessing).
        remediateNodeBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeAsgInstances',
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DescribeAutoScalingInstances'],
            resources: ['*'],
        }));

        // Grant states:StartExecution + DescribeExecution on the bootstrap state machine.
        // The tool re-triggers the orchestrator as the self-healing remediation action.
        remediateNodeBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'StartSfnExecution',
            effect: iam.Effect.ALLOW,
            actions: [
                'states:StartExecution',
                'states:DescribeExecution',
            ],
            resources: [stateMachineArn],
        }));

        // SSM GetParameter: allows fallback ARN resolution at runtime (local testing)
        remediateNodeBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ResolveSsmParameters',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/k8s/*`],
        }));

        // =================================================================
        // Tool Lambda 7: Inspect Workloads
        //
        // Runs five parallel kubectl queries (nodes, daemonsets, deployments,
        // statefulsets, events) in a single SSM command. Returns a unified
        // snapshot covering DaemonSet coverage (e.g. Traefik), Deployment
        // replicas, StatefulSet readiness, and recent Warning events.
        // =================================================================
        const inspectWorkloadsFn = new lambdaNode.NodejsFunction(this, 'InspectWorkloadsFunction', {
            functionName: `${namePrefix}-tool-inspect-workloads`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'inspect-workloads', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(90),
            logGroup: new logs.LogGroup(this, 'InspectWorkloadsLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-inspect-workloads`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: unified DaemonSet/Deployment/node/event inspection for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES],
            },
        });

        // Resolve control plane by tag
        inspectWorkloadsFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // SSM SendCommand (tag-scoped to k8s-tagged instances) + GetCommandInvocation
        inspectWorkloadsFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:SendCommand'],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: {
                StringEquals: { 'ssm:resourceTag/Project': 'kubernetes' },
            },
        }));
        inspectWorkloadsFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetCommandInvocation'],
            resources: ['*'],
        }));

        NagSuppressions.addResourceSuppressions(
            inspectWorkloadsFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard (dynamic instance IDs). SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Tool Lambda 8: Check Ingress Routes
        //
        // Queries Traefik IngressRoute and Middleware resources via SSM.
        // Used after bootstrap step 7 (applyIngress) failures or when
        // applications return 404. Also surfaces empty IPAllowList
        // sourceRanges (expected right after bootstrap — PostSync fills them).
        // =================================================================
        const checkIngressRoutesFn = new lambdaNode.NodejsFunction(this, 'CheckIngressRoutesFunction', {
            functionName: `${namePrefix}-tool-check-ingress-routes`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'check-ingress-routes', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(45),
            logGroup: new logs.LogGroup(this, 'CheckIngressRoutesLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-ingress-routes`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: verify Traefik IngressRoutes and Middlewares for ${namePrefix}`,
            bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES] },
        });

        checkIngressRoutesFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));
        checkIngressRoutesFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:SendCommand'],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: { StringEquals: { 'ssm:resourceTag/Project': 'kubernetes' } },
        }));
        checkIngressRoutesFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetCommandInvocation'],
            resources: ['*'],
        }));

        NagSuppressions.addResourceSuppressions(
            checkIngressRoutesFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard. SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Tool Lambda 9: Check Cert-Manager
        //
        // Queries cert-manager ClusterIssuer and Certificate resources via
        // SSM. Used after bootstrap step 5d (applyCertManagerIssuer) fails
        // or when TLS is broken. Surfaces the known SSM path mismatch issue
        // (edge/hosted-zone-id vs public-hosted-zone-id).
        // =================================================================
        const checkCertManagerFn = new lambdaNode.NodejsFunction(this, 'CheckCertManagerFunction', {
            functionName: `${namePrefix}-tool-check-cert-manager`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'check-cert-manager', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(45),
            logGroup: new logs.LogGroup(this, 'CheckCertManagerLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-cert-manager`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: verify cert-manager ClusterIssuer and Certificate health for ${namePrefix}`,
            bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES] },
        });

        checkCertManagerFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));
        checkCertManagerFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:SendCommand'],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: { StringEquals: { 'ssm:resourceTag/Project': 'kubernetes' } },
        }));
        checkCertManagerFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetCommandInvocation'],
            resources: ['*'],
        }));

        NagSuppressions.addResourceSuppressions(
            checkCertManagerFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard. SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Tool Lambda 10: Check ArgoCD Sync
        //
        // Queries ArgoCD Application sync and health status via SSM kubectl.
        // Used after bootstrap step 7 failures to confirm whether Helm charts
        // (argocd-ingress, monitoring) were applied by the GitOps loop.
        // =================================================================
        const checkArgoCDSyncFn = new lambdaNode.NodejsFunction(this, 'CheckArgoCDSyncFunction', {
            functionName: `${namePrefix}-tool-check-argocd-sync`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'check-argocd-sync', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(45),
            logGroup: new logs.LogGroup(this, 'CheckArgoCDSyncLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-argocd-sync`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: verify ArgoCD application sync status for ${namePrefix}`,
            bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES] },
        });

        checkArgoCDSyncFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));
        checkArgoCDSyncFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:SendCommand'],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
            ],
            conditions: { StringEquals: { 'ssm:resourceTag/Project': 'kubernetes' } },
        }));
        checkArgoCDSyncFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmGetCommandInvocation',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetCommandInvocation'],
            resources: ['*'],
        }));

        NagSuppressions.addResourceSuppressions(
            checkArgoCDSyncFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard. SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Register Tools with AgentCore Gateway
        //
        // Each tool is registered via addLambdaTarget() with an inline
        // ToolSchema defining the MCP tool interface. The L2 construct
        // automatically grants the Gateway's IAM role permission to
        // invoke each Lambda function.
        // =================================================================
        this.gateway.addLambdaTarget('DiagnoseAlarmTarget', {
            gatewayTargetName: 'diagnose-alarm',
            description: 'Analyse a CloudWatch Alarm and return diagnostic information',
            lambdaFunction: diagnoseAlarmFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'diagnose_alarm',
                description: 'Analyse a CloudWatch Alarm and return diagnostic information about the affected resource, including alarm configuration, threshold, recent metric datapoints, and affected resources.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Name of the CloudWatch Alarm to diagnose',
                        },
                    },
                    required: ['alarmName'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: { type: SchemaDefinitionType.STRING, description: 'Alarm name' },
                        exists: { type: SchemaDefinitionType.BOOLEAN, description: 'Whether the alarm exists' },
                        state: { type: SchemaDefinitionType.STRING, description: 'Current alarm state' },
                        stateReason: { type: SchemaDefinitionType.STRING, description: 'Reason for current state' },
                        recentDatapoints: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Recent metric values (last 30 minutes)',
                            items: { type: SchemaDefinitionType.NUMBER },
                        },
                    },
                },
            }]),
        });


        this.gateway.addLambdaTarget('CheckNodeHealthTarget', {
            gatewayTargetName: 'check-node-health',
            description: 'Check Kubernetes node health via SSM on the control plane',
            lambdaFunction: checkNodeHealthFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_node_health',
                description: 'Check whether Kubernetes worker nodes have joined the cluster and are in Ready state. Runs kubectl on the control plane node via SSM.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        nodeNameFilter: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional substring filter for node names (e.g. "worker" or "app")',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used for the check' },
                        totalNodes: { type: SchemaDefinitionType.NUMBER, description: 'Total number of nodes' },
                        readyNodes: { type: SchemaDefinitionType.NUMBER, description: 'Number of Ready nodes' },
                        notReadyNodes: { type: SchemaDefinitionType.NUMBER, description: 'Number of NotReady nodes' },
                        nodes: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Per-node health details',
                            items: { type: SchemaDefinitionType.OBJECT },
                        },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('AnalyseClusterHealthTarget', {
            gatewayTargetName: 'analyse-cluster-health',
            description: 'Analyse Kubernetes cluster health using K8sGPT diagnostics',
            lambdaFunction: analyseClusterHealthFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'analyse_cluster_health',
                description: 'Analyse Kubernetes cluster health using K8sGPT. Diagnoses workload issues such as failing pods, misconfigured services, and unhealthy deployments. Falls back to kubectl if K8sGPT is not installed.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        namespace: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional namespace to analyse (e.g. "argocd", "cert-manager"). Omit for cluster-wide analysis.',
                        },
                        filters: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Optional K8sGPT analyser filters (e.g. ["Pod", "Service", "Ingress"])',
                            items: { type: SchemaDefinitionType.STRING },
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used' },
                        healthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True if no issues found' },
                        totalIssues: { type: SchemaDefinitionType.NUMBER, description: 'Total issues found' },
                        criticalIssues: { type: SchemaDefinitionType.NUMBER, description: 'Critical workload issues' },
                        analysisMethod: { type: SchemaDefinitionType.STRING, description: 'k8sgpt or kubectl-fallback' },
                        issues: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Per-issue diagnostics',
                            items: { type: SchemaDefinitionType.OBJECT },
                        },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('GetNodeDiagnosticTarget', {
            gatewayTargetName: 'get-node-diagnostic-json',
            description: 'Fetch bootstrap diagnostic run_summary.json from a Kubernetes node',
            lambdaFunction: getNodeDiagnosticFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'get_node_diagnostic_json',
                description: 'Fetch the machine-readable run_summary.json bootstrap diagnostic file from a Kubernetes node via SSM. Returns the overall bootstrap status, failure classification code, and per-step timing and errors.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: {
                            type: SchemaDefinitionType.STRING,
                            description: 'EC2 instance ID of the node to diagnose',
                        },
                    },
                    required: ['instanceId'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: { type: SchemaDefinitionType.STRING, description: 'Target instance ID' },
                        found: { type: SchemaDefinitionType.BOOLEAN, description: 'Whether run_summary.json exists on the node' },
                        failureCode: { type: SchemaDefinitionType.STRING, description: 'Machine-readable failure classification (e.g. AMI_MISMATCH, KUBEADM_FAIL)' },
                        failedSteps: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Names of bootstrap steps that failed',
                            items: { type: SchemaDefinitionType.STRING },
                        },
                        summary: { type: SchemaDefinitionType.OBJECT, description: 'Full parsed run_summary.json content' },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('RemediateNodeBootstrapTarget', {
            gatewayTargetName: 'remediate-node-bootstrap',
            description: 'Trigger Step Functions bootstrap orchestrator to re-bootstrap a failed Kubernetes node',
            lambdaFunction: remediateNodeBootstrapFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'remediate_node_bootstrap',
                description: 'Trigger the Step Functions bootstrap orchestrator to re-run the full bootstrap sequence on a failed Kubernetes node. Starts a new execution targeting the specified instance and role. Returns the execution ARN for tracking progress in the AWS console.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: {
                            type: SchemaDefinitionType.STRING,
                            description: 'EC2 instance ID of the node to remediate',
                        },
                        role: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Node role: "control-plane" or "worker"',
                        },
                    },
                    required: ['instanceId', 'role'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: { type: SchemaDefinitionType.STRING, description: 'Target instance ID' },
                        role: { type: SchemaDefinitionType.STRING, description: 'Node role used for remediation' },
                        executionArn: { type: SchemaDefinitionType.STRING, description: 'Step Functions execution ARN for tracking' },
                        status: { type: SchemaDefinitionType.STRING, description: 'triggered or error' },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('InspectWorkloadsTarget', {
            gatewayTargetName: 'inspect-workloads',
            description: 'Unified cluster workload inspection: nodes, DaemonSets, Deployments, StatefulSets, Warning events',
            lambdaFunction: inspectWorkloadsFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'inspect_workloads',
                description: 'Run a comprehensive cluster health inspection in a single call. Returns node readiness, DaemonSet coverage (e.g. Traefik on all nodes), Deployment and StatefulSet replica status, and recent Warning events (CrashLoopBackOff, OOMKilled, ImagePullBackOff, FailedScheduling). Use this as the first tool when diagnosing cluster-level failures, pod crashes, or missing workloads. Faster than running check_node_health and analyse_cluster_health separately.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        namespaces: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Optional list of namespaces to limit results (e.g. ["kube-system", "traefik"]). Omit for cluster-wide inspection.',
                            items: { type: SchemaDefinitionType.STRING },
                        },
                        maxEvents: {
                            type: SchemaDefinitionType.NUMBER,
                            description: 'Maximum number of Warning events to return (default 50)',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used for inspection' },
                        clusterHealthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True only when all nodes Ready and all workloads at desired capacity' },
                        nodes: { type: SchemaDefinitionType.OBJECT, description: 'Node totals and per-node detail' },
                        daemonSets: { type: SchemaDefinitionType.ARRAY, description: 'DaemonSet desired/ready/misscheduled per entry', items: { type: SchemaDefinitionType.OBJECT } },
                        deployments: { type: SchemaDefinitionType.ARRAY, description: 'Deployment desired/available per entry', items: { type: SchemaDefinitionType.OBJECT } },
                        statefulSets: { type: SchemaDefinitionType.ARRAY, description: 'StatefulSet desired/ready per entry', items: { type: SchemaDefinitionType.OBJECT } },
                        events: { type: SchemaDefinitionType.ARRAY, description: 'Recent Warning events (most recent first)', items: { type: SchemaDefinitionType.OBJECT } },
                        summary: { type: SchemaDefinitionType.ARRAY, description: 'Human-readable bullet list of key findings', items: { type: SchemaDefinitionType.STRING } },
                    },
                },
            }]),
        });

        // =================================================================
        // Tool Lambda 11: Check Security Group Rules
        //
        // Queries EC2 SGs tagged Project=kubernetes for port 443 ingress
        // rules. Detects the pattern where ALLOW_IPV4 was not set at CDK
        // synth → IPv4 admin access missing from SG. READ-ONLY — reports
        // but never modifies SG rules. Fix = CDK redeploy with ALLOW_IPV4.
        // =================================================================
        const checkSgRulesFn = new lambdaNode.NodejsFunction(this, 'CheckSgRulesFunction', {
            functionName: `${namePrefix}-tool-check-sg-rules`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', 'check-security-group-rules', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'CheckSgRulesLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-sg-rules`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: inspect k8s SG port-443 ingress rules for ${namePrefix}`,
            bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*', ...OBSERVABILITY_EXTERNAL_MODULES] },
        });

        checkSgRulesFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeSecurityGroups',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeSecurityGroups'],
            resources: ['*'],
        }));

        NagSuppressions.addResourceSuppressions(
            checkSgRulesFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeSecurityGroups has no resource-level filtering — requires wildcard.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        this.gateway.addLambdaTarget('CheckIngressRoutesTarget', {
            gatewayTargetName: 'check-ingress-routes',
            description: 'Verify Traefik IngressRoute and Middleware resources after bootstrap',
            lambdaFunction: checkIngressRoutesFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_ingress_routes',
                description: 'Verify Traefik IngressRoute and Middleware resources on the cluster. Use after bootstrap step 7 (applyIngress) failures or when applications return 404. Also surfaces empty IPAllowList sourceRanges — note that empty sourceRanges immediately after bootstrap is expected behaviour (PostSync ArgoCD patcher fills them in after sync completes).',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        namespace: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional: scope to a single namespace (e.g. "argocd", "monitoring"). Omit for cluster-wide.',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used' },
                        healthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True when all IngressRoutes have routes and no critical issues' },
                        ingressRoutes: { type: SchemaDefinitionType.ARRAY, description: 'Per-IngressRoute details', items: { type: SchemaDefinitionType.OBJECT } },
                        middlewares: { type: SchemaDefinitionType.ARRAY, description: 'Per-Middleware details including sourceRanges', items: { type: SchemaDefinitionType.OBJECT } },
                        issues: { type: SchemaDefinitionType.ARRAY, description: 'Detected problems (missing routes, empty sourceRanges)', items: { type: SchemaDefinitionType.STRING } },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('CheckCertManagerTarget', {
            gatewayTargetName: 'check-cert-manager',
            description: 'Verify cert-manager ClusterIssuer and Certificate health',
            lambdaFunction: checkCertManagerFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_cert_manager',
                description: 'Verify cert-manager ClusterIssuer and Certificate resources. Use after bootstrap step 5d (applyCertManagerIssuer) failures or when TLS is broken. If no ClusterIssuers are found, the SSM path mismatch is the likely cause: CDK stores them at edge/hosted-zone-id and edge/cross-account-role-arn (NOT public-hosted-zone-id).',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {},
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used' },
                        healthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True when all ClusterIssuers Ready and no certificates in Failed state' },
                        clusterIssuers: { type: SchemaDefinitionType.ARRAY, description: 'Per-issuer status', items: { type: SchemaDefinitionType.OBJECT } },
                        certificates: { type: SchemaDefinitionType.ARRAY, description: 'Per-certificate status and expiry', items: { type: SchemaDefinitionType.OBJECT } },
                        issues: { type: SchemaDefinitionType.ARRAY, description: 'Detected problems (missing issuer, not-ready, expiring certs)', items: { type: SchemaDefinitionType.STRING } },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('CheckArgoCDSyncTarget', {
            gatewayTargetName: 'check-argocd-sync',
            description: 'Verify ArgoCD application sync and health status',
            lambdaFunction: checkArgoCDSyncFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_argocd_sync',
                description: 'Verify ArgoCD application sync and health status. Use after bootstrap step 7 (applyIngress) failures to confirm whether Helm charts were deployed by the GitOps loop, or when applications are missing resources that should have been applied by ArgoCD.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        appName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional: filter to a specific ArgoCD app name (e.g. "argocd-ingress", "monitoring")',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used' },
                        healthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True when all apps are Synced and Healthy' },
                        applications: { type: SchemaDefinitionType.ARRAY, description: 'Per-app sync and health status', items: { type: SchemaDefinitionType.OBJECT } },
                        issues: { type: SchemaDefinitionType.ARRAY, description: 'Apps that are OutOfSync, Degraded, or Progressing', items: { type: SchemaDefinitionType.STRING } },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('CheckSgRulesTarget', {
            gatewayTargetName: 'check-sg-rules',
            description: 'Inspect k8s EC2 Security Group port-443 ingress rules (read-only)',
            lambdaFunction: checkSgRulesFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_security_group_rules',
                description: 'Inspect EC2 Security Group ingress rules for the k8s cluster (tagged Project=kubernetes). Use when the cluster is healthy but admin endpoints are unreachable from outside — this detects the pattern where ALLOW_IPV4 was not set at CDK synth time and only the IPv6 ingress rule was added. READ-ONLY: reports missing CIDRs and the CDK env vars needed to fix, but never modifies SG rules.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        adminCidr: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional: expected admin IPv4 CIDR to explicitly check (e.g. "37.228.224.56/32")',
                        },
                        port: {
                            type: SchemaDefinitionType.NUMBER,
                            description: 'Port to check ingress rules for (default: 443)',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        securityGroups: { type: SchemaDefinitionType.ARRAY, description: 'Per-SG details with ingress rules for the target port', items: { type: SchemaDefinitionType.OBJECT } },
                        missingAdminCidr: { type: SchemaDefinitionType.BOOLEAN, description: 'True when adminCidr was provided and not found in any SG' },
                        issues: { type: SchemaDefinitionType.ARRAY, description: 'Detected problems (missing CIDRs, no rules for port)', items: { type: SchemaDefinitionType.STRING } },
                        remediationNote: { type: SchemaDefinitionType.STRING, description: 'CDK env vars and steps needed to permanently fix the SG' },
                    },
                },
            }]),
        });

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Gateway L2 construct auto-generates IAM role with least-privilege for registered Lambda targets',
            }, {
                id: 'AwsSolutions-COG1',
                reason: 'Cognito User Pool is auto-created by Gateway L2 for M2M auth — password policy not applicable for client credentials flow',
            }, {
                id: 'AwsSolutions-COG2',
                reason: 'MFA not applicable for M2M client credentials flow — no end-user authentication involved',
            }, {
                id: 'AwsSolutions-COG3',
                reason: 'AdvancedSecurityMode not applicable for M2M client credentials flow — no end-user passwords to protect from compromise',
            }, {
                id: 'AwsSolutions-COG8',
                reason: 'Plus tier / feature plan not required for M2M client credentials flow — no end-user sign-in, advanced security features, or threat protection needed',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            diagnoseAlarmFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'CloudWatch DescribeAlarms and GetMetricData require wildcard resource — alarm ARN is not known at synthesis time',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );


        NagSuppressions.addResourceSuppressions(
            checkNodeHealthFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard (dynamic instance IDs). SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard (no resource-level filtering)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            analyseClusterHealthFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances requires wildcard (dynamic instance IDs). SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard (no resource-level filtering)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            getNodeDiagnosticFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'SSM SendCommand is tag-scoped (Project=kubernetes). ssm:GetCommandInvocation requires wildcard (no resource-level filtering)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            remediateNodeBootstrapFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'ssm:GetParameter requires wildcard path prefix for fallback ARN resolution. states:StartExecution is scoped to the specific bootstrap state machine ARN. autoscaling:DescribeAutoScalingInstances has no resource-level filtering.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Application Inference Profile — FinOps Cost Attribution
        //
        // Creates a tagged profile for the Self-Healing Agent to enable
        // per-pipeline Bedrock billing in AWS Cost Explorer.
        // =================================================================
        const agentProfile = new ApplicationInferenceProfile(this, 'AgentSonnetProfile', {
            profileName: `${namePrefix}-agent-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Self healing agent Sonnet 4.6',
            tags: [
                { key: 'project', value: 'self-healing' },
                { key: 'cost-centre', value: 'platform' },
                { key: 'component', value: 'compute' },
                { key: 'environment', value: props.environmentName },
                { key: 'owner', value: 'nelson-l' },
                { key: 'managed-by', value: 'cdk' },
            ],
        });
        this.agentProfileArn = agentProfile.profileArn;

        // =================================================================
        // Observability — wire ADOT + DEPLOY_ENV onto every tool Lambda
        // in this stack. Single call covers all 10+ AgentCore tool
        // Functions; each becomes a distinct service in Tempo / X-Ray:
        //   <namePrefix>-gateway-diagnoseAlarm
        //   <namePrefix>-gateway-checkNodeHealth
        //   <namePrefix>-gateway-remediateNodeBootstrap
        //   ... etc. (derived from each Function's CDK logical id)
        // =================================================================
        addLambdaObservabilityToAll(this, {
            serviceNamePrefix: `${namePrefix}-gateway`,
            environment:       props.environmentName,
        });

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'GatewayUrlParam', {
            parameterName: `/${namePrefix}/gateway-url`,
            stringValue: this.gatewayUrl,
            description: `AgentCore Gateway URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'GatewayIdParam', {
            parameterName: `/${namePrefix}/gateway-id`,
            stringValue: this.gatewayId,
            description: `AgentCore Gateway ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gatewayUrl,
            description: 'AgentCore Gateway endpoint URL',
        });

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gatewayId,
            description: 'AgentCore Gateway identifier',
        });

        new cdk.CfnOutput(this, 'GatewayArn', {
            value: this.gateway.gatewayArn,
            description: 'AgentCore Gateway ARN',
        });

        // Suppress log group output for gateway
        // CloudWatch log group is automatically created on first invocation
    }
}
