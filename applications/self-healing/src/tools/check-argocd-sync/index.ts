/**
 * @format
 * Check ArgoCD Sync — MCP Tool Lambda
 *
 * Queries ArgoCD Application resources on the control plane via SSM to
 * verify that applications are Synced and Healthy after a bootstrap cycle.
 *
 * Context: Bootstrap step 7 (applyIngress) failed in a race condition where
 * a redundant ArgoCD pods readiness guard was still running. This tool lets
 * the agent verify ArgoCD app sync status after the node bootstrap completes,
 * catching cases where Helm charts were not deployed by ArgoCD's GitOps loop.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - appName (string, optional): filter to a specific ArgoCD app name
 *
 * Output:
 *   - controlPlaneInstanceId
 *   - applications[]: per-app name, namespace, syncStatus, healthStatus, lastSyncedAt, conditions
 *   - issues[]: apps that are OutOfSync, Degraded, or have sync errors
 *   - healthy: true when all apps are Synced + Healthy
 */

import {
    EC2Client,
    DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
    SSMClient,
    SendCommandCommand,
    GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import { log } from '@bedrock/shared';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

const SSM_POLL_TIMEOUT_MS = 30_000;
const SSM_POLL_INTERVAL_MS = 2_000;

// =============================================================================
// Types
// =============================================================================

export interface CheckArgoCDSyncInput {
    readonly appName?: string;
}

export interface ArgoCDAppEntry {
    readonly name: string;
    readonly namespace: string;
    readonly project: string;
    readonly repoURL: string;
    readonly targetRevision: string;
    readonly path: string;
    readonly syncStatus: 'Synced' | 'OutOfSync' | 'Unknown';
    readonly healthStatus: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';
    readonly lastSyncedAt?: string;
    readonly syncMessage?: string;
}

export interface ArgoCDSyncReport {
    readonly controlPlaneInstanceId: string;
    readonly healthy: boolean;
    readonly applications: ArgoCDAppEntry[];
    readonly issues: string[];
    readonly error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveControlPlaneInstance(): Promise<string | undefined> {
    const result = await ec2.send(
        new DescribeInstancesCommand({
            Filters: [
                { Name: 'tag:k8s:bootstrap-role', Values: ['control-plane'] },
                { Name: 'instance-state-name', Values: ['running'] },
            ],
        }),
    );
    const instances = result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
    return instances[0]?.InstanceId;
}

async function ssmExec(instanceId: string, command: string): Promise<string | undefined> {
    const sendResult = await ssm.send(
        new SendCommandCommand({
            InstanceIds: [instanceId],
            DocumentName: 'AWS-RunShellScript',
            Parameters: { commands: [command] },
            TimeoutSeconds: 25,
        }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) return undefined;

    const maxAttempts = Math.ceil(SSM_POLL_TIMEOUT_MS / SSM_POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(SSM_POLL_INTERVAL_MS);
        try {
            const invocation = await ssm.send(
                new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
            );
            if (invocation.Status === 'Success') {
                return invocation.StandardOutputContent ?? '';
            }
            if (invocation.Status === 'Failed' || invocation.Status === 'Cancelled') {
                log('WARN', 'SSM command failed', {
                    commandId,
                    status: invocation.Status,
                    stderr: invocation.StandardErrorContent?.slice(0, 300),
                });
                return invocation.StandardOutputContent ?? '';
            }
        } catch {
            // continue polling
        }
    }
    return undefined;
}

// =============================================================================
// Output Parsing
// =============================================================================

function parseArgoCDApps(raw: string): ArgoCDAppEntry[] {
    try {
        const list = JSON.parse(raw) as { items?: unknown[] };
        return (list.items ?? []).map((item) => {
            const i = item as Record<string, unknown>;
            const meta = (i['metadata'] ?? {}) as Record<string, unknown>;
            const spec = (i['spec'] ?? {}) as Record<string, unknown>;
            const status = (i['status'] ?? {}) as Record<string, unknown>;
            const source = (spec['source'] ?? {}) as Record<string, unknown>;
            const syncStatus = (status['sync'] ?? {}) as Record<string, unknown>;
            const healthStatus = (status['health'] ?? {}) as Record<string, unknown>;
            const operationState = (status['operationState'] ?? {}) as Record<string, unknown>;
            const syncResult = (operationState['syncResult'] ?? {}) as Record<string, unknown>;

            return {
                name: String(meta['name'] ?? 'unknown'),
                namespace: String(meta['namespace'] ?? 'argocd'),
                project: String(spec['project'] ?? 'default'),
                repoURL: String(source['repoURL'] ?? ''),
                targetRevision: String(source['targetRevision'] ?? 'HEAD'),
                path: String(source['path'] ?? source['chart'] ?? ''),
                syncStatus: (String(syncStatus['status'] ?? 'Unknown')) as ArgoCDAppEntry['syncStatus'],
                healthStatus: (String(healthStatus['status'] ?? 'Unknown')) as ArgoCDAppEntry['healthStatus'],
                lastSyncedAt: (operationState['finishedAt'] as string | undefined),
                syncMessage: String(syncResult['revision'] ?? syncStatus['revision'] ?? ''),
            };
        });
    } catch {
        return [];
    }
}

function detectIssues(apps: ArgoCDAppEntry[]): string[] {
    const issues: string[] = [];
    for (const app of apps) {
        if (app.syncStatus !== 'Synced') {
            issues.push(`ArgoCD app "${app.name}" is ${app.syncStatus} — expected Synced`);
        }
        if (app.healthStatus === 'Degraded' || app.healthStatus === 'Missing') {
            issues.push(`ArgoCD app "${app.name}" health is ${app.healthStatus}`);
        }
        if (app.healthStatus === 'Progressing') {
            issues.push(`ArgoCD app "${app.name}" is still Progressing — resources not yet fully rolled out`);
        }
    }
    return issues;
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(input: CheckArgoCDSyncInput): Promise<ArgoCDSyncReport> {
    const instanceId = await resolveControlPlaneInstance();
    if (!instanceId) {
        return {
            controlPlaneInstanceId: 'not-found',
            healthy: false,
            applications: [],
            issues: ['Could not find a running control-plane instance with tag k8s:bootstrap-role=control-plane'],
        };
    }

    log('INFO', 'Checking ArgoCD application sync status via SSM', {
        instanceId,
        appName: input.appName ?? 'all',
    });

    const nameFilter = input.appName ? ` ${input.appName}` : '';
    const command = `kubectl get applications.argoproj.io${nameFilter} -n argocd -o json 2>/dev/null`;

    const output = await ssmExec(instanceId, command);
    if (!output) {
        return {
            controlPlaneInstanceId: instanceId,
            healthy: false,
            applications: [],
            issues: ['SSM command timed out or returned no output'],
        };
    }

    const applications = parseArgoCDApps(output);
    const issues = detectIssues(applications);
    const healthy =
        applications.length > 0 &&
        applications.every((a) => a.syncStatus === 'Synced' && a.healthStatus === 'Healthy');

    log('INFO', 'ArgoCD sync check complete', {
        instanceId,
        appCount: applications.length,
        issueCount: issues.length,
        healthy,
    });

    return { controlPlaneInstanceId: instanceId, healthy, applications, issues };
}
