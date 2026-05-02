/**
 * @format
 * Check Ingress Routes — MCP Tool Lambda
 *
 * Queries Traefik IngressRoute and Middleware resources on the control
 * plane via SSM to verify that expected application routes are deployed
 * and configured correctly after a bootstrap cycle.
 *
 * Useful when a bootstrap alarm fires after step 7 (apply-ingress) to
 * confirm whether IngressRoutes were actually created by the Helm chart.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - namespace (string, optional): scope to a single namespace (e.g. "argocd")
 *
 * Output:
 *   - controlPlaneInstanceId: EC2 instance used for the check
 *   - ingressRoutes[]: per-route name, namespace, entrypoints, routes[], tls
 *   - middlewares[]: per-middleware name, namespace, type, configuration summary
 *   - issues[]: human-readable list of detected problems (empty routes, missing tls, etc.)
 *   - healthy: true when all IngressRoutes have at least one route and no obvious issues
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

export interface CheckIngressRoutesInput {
    readonly namespace?: string;
}

export interface IngressRouteEntry {
    readonly name: string;
    readonly namespace: string;
    readonly entryPoints: string[];
    readonly routeCount: number;
    readonly routes: Array<{ match: string; kind: string; services?: string[] }>;
    readonly hasTls: boolean;
    readonly tlsSecretName?: string;
}

export interface MiddlewareEntry {
    readonly name: string;
    readonly namespace: string;
    readonly type: string;
    readonly summary: string;
}

export interface IngressRoutesReport {
    readonly controlPlaneInstanceId: string;
    readonly healthy: boolean;
    readonly ingressRoutes: IngressRouteEntry[];
    readonly middlewares: MiddlewareEntry[];
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

function parseIngressRoutes(raw: string): IngressRouteEntry[] {
    try {
        const list = JSON.parse(raw) as { items?: unknown[] };
        const items = list.items ?? [];
        return items.map((item) => {
            const i = item as Record<string, unknown>;
            const meta = (i['metadata'] ?? {}) as Record<string, unknown>;
            const spec = (i['spec'] ?? {}) as Record<string, unknown>;
            const routes = (spec['routes'] ?? []) as Array<Record<string, unknown>>;
            const tls = spec['tls'] as Record<string, unknown> | undefined;

            return {
                name: String(meta['name'] ?? 'unknown'),
                namespace: String(meta['namespace'] ?? 'unknown'),
                entryPoints: (spec['entryPoints'] ?? []) as string[],
                routeCount: routes.length,
                routes: routes.map((r) => ({
                    match: String(r['match'] ?? ''),
                    kind: String(r['kind'] ?? 'Rule'),
                    services: ((r['services'] ?? []) as Array<Record<string, unknown>>)
                        .map((s) => String(s['name'] ?? '')),
                })),
                hasTls: !!tls,
                tlsSecretName: tls ? String((tls['secretName'] ?? tls['store'] ?? '')) : undefined,
            };
        });
    } catch {
        return [];
    }
}

function parseMiddlewares(raw: string): MiddlewareEntry[] {
    try {
        const list = JSON.parse(raw) as { items?: unknown[] };
        const items = list.items ?? [];
        return items.map((item) => {
            const i = item as Record<string, unknown>;
            const meta = (i['metadata'] ?? {}) as Record<string, unknown>;
            const spec = (i['spec'] ?? {}) as Record<string, unknown>;
            const specKeys = Object.keys(spec);
            const type = specKeys[0] ?? 'unknown';

            // Summarize IPAllowList or IPWhiteList sourceRanges
            let summary = type;
            const typeSpec = spec[type] as Record<string, unknown> | undefined;
            if (typeSpec && (type === 'ipAllowList' || type === 'ipWhiteList')) {
                const ranges = (typeSpec['sourceRanges'] ?? []) as string[];
                summary = ranges.length > 0
                    ? `${type}: sourceRanges=[${ranges.join(', ')}]`
                    : `${type}: sourceRanges=[] (EMPTY — routes using this middleware will be blocked)`;
            }

            return {
                name: String(meta['name'] ?? 'unknown'),
                namespace: String(meta['namespace'] ?? 'unknown'),
                type,
                summary,
            };
        });
    } catch {
        return [];
    }
}

function detectIssues(routes: IngressRouteEntry[], middlewares: MiddlewareEntry[]): string[] {
    const issues: string[] = [];

    for (const r of routes) {
        if (r.routeCount === 0) {
            issues.push(`IngressRoute "${r.namespace}/${r.name}" has no routes — may be misconfigured or chart not applied`);
        }
        if (r.entryPoints.length === 0) {
            issues.push(`IngressRoute "${r.namespace}/${r.name}" has no entryPoints`);
        }
    }

    for (const m of middlewares) {
        if (m.summary.includes('EMPTY')) {
            issues.push(`Middleware "${m.namespace}/${m.name}": ${m.summary} — This is expected immediately after bootstrap if the PostSync patcher has not yet run`);
        }
    }

    return issues;
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(input: CheckIngressRoutesInput): Promise<IngressRoutesReport> {
    const nsFlag = input.namespace ? `-n ${input.namespace}` : '-A';

    const instanceId = await resolveControlPlaneInstance();
    if (!instanceId) {
        return {
            controlPlaneInstanceId: 'not-found',
            healthy: false,
            ingressRoutes: [],
            middlewares: [],
            issues: ['Could not find a running control-plane instance with tag k8s:bootstrap-role=control-plane'],
        };
    }

    log('INFO', 'Checking IngressRoutes via SSM', { instanceId, namespace: input.namespace ?? 'all' });

    const command = [
        `kubectl get ingressroute ${nsFlag} -o json 2>/dev/null`,
        `echo "---MIDDLEWARE---"`,
        `kubectl get middleware ${nsFlag} -o json 2>/dev/null`,
    ].join(' && ');

    const output = await ssmExec(instanceId, command);
    if (!output) {
        return {
            controlPlaneInstanceId: instanceId,
            healthy: false,
            ingressRoutes: [],
            middlewares: [],
            issues: ['SSM command timed out or returned no output'],
        };
    }

    const [routesPart, middlewarePart] = output.split('---MIDDLEWARE---');

    const ingressRoutes = parseIngressRoutes(routesPart?.trim() ?? '');
    const middlewares = parseMiddlewares(middlewarePart?.trim() ?? '');
    const issues = detectIssues(ingressRoutes, middlewares);

    // Healthy = at least one IngressRoute found AND no routes with 0 match rules
    // (empty sourceRanges is informational only — PostSync patcher fills it in)
    const emptyRouteIssues = issues.filter(i => i.includes('has no routes') || i.includes('no entryPoints'));
    const healthy = ingressRoutes.length > 0 && emptyRouteIssues.length === 0;

    log('INFO', 'IngressRoute check complete', {
        instanceId,
        routeCount: ingressRoutes.length,
        middlewareCount: middlewares.length,
        issueCount: issues.length,
        healthy,
    });

    return { controlPlaneInstanceId: instanceId, healthy, ingressRoutes, middlewares, issues };
}
