/**
 * @format
 * Check Cert-Manager — MCP Tool Lambda
 *
 * Queries cert-manager ClusterIssuer and Certificate resources on the
 * control plane via SSM. Surfaces missing or not-ready issuers and
 * certificates that are approaching expiry or in a failed state.
 *
 * Context: Bootstrap step 5d (applyCertManagerIssuer) applies the
 * ClusterIssuer manifest. If step 5d fails, the ClusterIssuer may be
 * absent or in a Failed/Pending state. This tool gives the agent
 * visibility into cert-manager health without manual kubectl access.
 *
 * Known SSM path issue (fixed 2026-05-02): applyCertManagerIssuer
 * previously read `public-hosted-zone-id` and `cross-account-dns-role-arn`
 * but CDK stores them at `edge/hosted-zone-id` and `edge/cross-account-role-arn`.
 * If this tool shows ClusterIssuer absent, check whether the SSM paths
 * are correctly set before triggering a re-bootstrap.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - none required
 *
 * Output:
 *   - controlPlaneInstanceId
 *   - clusterIssuers[]: per-issuer name, type, ready status, conditions
 *   - certificates[]: per-cert name, namespace, issuerRef, ready, notAfter, conditions
 *   - issues[]: human-readable problems (missing issuer, not-ready, expiring certs)
 *   - healthy: true when all ClusterIssuers are Ready and no certs in Failed state
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

export interface ClusterIssuerEntry {
    readonly name: string;
    readonly type: 'ACME' | 'CA' | 'SelfSigned' | 'Vault' | 'Unknown';
    readonly ready: boolean;
    readonly message?: string;
    readonly acmeServer?: string;
}

export interface CertificateEntry {
    readonly name: string;
    readonly namespace: string;
    readonly issuerRef: string;
    readonly ready: boolean;
    readonly notAfter?: string;
    readonly daysUntilExpiry?: number;
    readonly message?: string;
}

export interface CertManagerReport {
    readonly controlPlaneInstanceId: string;
    readonly healthy: boolean;
    readonly clusterIssuers: ClusterIssuerEntry[];
    readonly certificates: CertificateEntry[];
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

function parseClusterIssuers(raw: string): ClusterIssuerEntry[] {
    try {
        const list = JSON.parse(raw) as { items?: unknown[] };
        return (list.items ?? []).map((item) => {
            const i = item as Record<string, unknown>;
            const meta = (i['metadata'] ?? {}) as Record<string, unknown>;
            const spec = (i['spec'] ?? {}) as Record<string, unknown>;
            const status = (i['status'] ?? {}) as Record<string, unknown>;
            const conditions = ((status['conditions'] ?? []) as Array<Record<string, unknown>>);

            const readyCondition = conditions.find((c) => c['type'] === 'Ready');
            const ready = readyCondition?.['status'] === 'True';
            const message = String(readyCondition?.['message'] ?? '');

            let type: ClusterIssuerEntry['type'] = 'Unknown';
            if (spec['acme']) type = 'ACME';
            else if (spec['ca']) type = 'CA';
            else if (spec['selfSigned']) type = 'SelfSigned';
            else if (spec['vault']) type = 'Vault';

            const acme = spec['acme'] as Record<string, unknown> | undefined;

            return {
                name: String(meta['name'] ?? 'unknown'),
                type,
                ready,
                message: message || undefined,
                acmeServer: acme ? String(acme['server'] ?? '') : undefined,
            };
        });
    } catch {
        return [];
    }
}

function parseCertificates(raw: string): CertificateEntry[] {
    try {
        const list = JSON.parse(raw) as { items?: unknown[] };
        return (list.items ?? []).map((item) => {
            const i = item as Record<string, unknown>;
            const meta = (i['metadata'] ?? {}) as Record<string, unknown>;
            const spec = (i['spec'] ?? {}) as Record<string, unknown>;
            const status = (i['status'] ?? {}) as Record<string, unknown>;

            const conditions = ((status['conditions'] ?? []) as Array<Record<string, unknown>>);
            const readyCondition = conditions.find((c) => c['type'] === 'Ready');
            const ready = readyCondition?.['status'] === 'True';
            const message = String(readyCondition?.['message'] ?? '');

            const notAfterStr = status['notAfter'] as string | undefined;
            let daysUntilExpiry: number | undefined;
            if (notAfterStr) {
                const diffMs = new Date(notAfterStr).getTime() - Date.now();
                daysUntilExpiry = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            }

            const issuerRef = spec['issuerRef'] as Record<string, unknown> | undefined;

            return {
                name: String(meta['name'] ?? 'unknown'),
                namespace: String(meta['namespace'] ?? 'unknown'),
                issuerRef: issuerRef
                    ? `${issuerRef['kind'] ?? 'Issuer'}/${issuerRef['name'] ?? 'unknown'}`
                    : 'unknown',
                ready,
                notAfter: notAfterStr,
                daysUntilExpiry,
                message: message || undefined,
            };
        });
    } catch {
        return [];
    }
}

function detectIssues(issuers: ClusterIssuerEntry[], certs: CertificateEntry[]): string[] {
    const issues: string[] = [];

    if (issuers.length === 0) {
        issues.push(
            'No ClusterIssuers found — bootstrap step 5d (applyCertManagerIssuer) may have failed. ' +
            'Check SSM paths: CDK stores them at edge/hosted-zone-id and edge/cross-account-role-arn.',
        );
    }

    for (const issuer of issuers) {
        if (!issuer.ready) {
            issues.push(`ClusterIssuer "${issuer.name}" is NOT Ready: ${issuer.message ?? 'no message'}`);
        }
    }

    for (const cert of certs) {
        if (!cert.ready) {
            issues.push(`Certificate "${cert.namespace}/${cert.name}" is NOT Ready: ${cert.message ?? 'no message'}`);
        }
        if (cert.daysUntilExpiry !== undefined && cert.daysUntilExpiry < 30) {
            issues.push(`Certificate "${cert.namespace}/${cert.name}" expires in ${cert.daysUntilExpiry} days (${cert.notAfter})`);
        }
    }

    return issues;
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(): Promise<CertManagerReport> {
    const instanceId = await resolveControlPlaneInstance();
    if (!instanceId) {
        return {
            controlPlaneInstanceId: 'not-found',
            healthy: false,
            clusterIssuers: [],
            certificates: [],
            issues: ['Could not find a running control-plane instance with tag k8s:bootstrap-role=control-plane'],
        };
    }

    log('INFO', 'Checking cert-manager resources via SSM', { instanceId });

    const command = [
        'kubectl get clusterissuer -o json 2>/dev/null',
        'echo "---CERTS---"',
        'kubectl get certificate -A -o json 2>/dev/null',
    ].join(' && ');

    const output = await ssmExec(instanceId, command);
    if (!output) {
        return {
            controlPlaneInstanceId: instanceId,
            healthy: false,
            clusterIssuers: [],
            certificates: [],
            issues: ['SSM command timed out or returned no output'],
        };
    }

    const [issuerPart, certPart] = output.split('---CERTS---');

    const clusterIssuers = parseClusterIssuers(issuerPart?.trim() ?? '');
    const certificates = parseCertificates(certPart?.trim() ?? '');
    const issues = detectIssues(clusterIssuers, certificates);

    const healthy =
        clusterIssuers.length > 0 &&
        clusterIssuers.every((i) => i.ready) &&
        certificates.every((c) => c.ready);

    log('INFO', 'Cert-manager check complete', {
        instanceId,
        issuerCount: clusterIssuers.length,
        certCount: certificates.length,
        issueCount: issues.length,
        healthy,
    });

    return { controlPlaneInstanceId: instanceId, healthy, clusterIssuers, certificates, issues };
}
