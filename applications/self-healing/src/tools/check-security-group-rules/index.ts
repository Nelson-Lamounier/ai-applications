/**
 * @format
 * Check Security Group Rules — MCP Tool Lambda
 *
 * Queries EC2 Security Groups associated with the Kubernetes cluster and
 * reports their port 443 (HTTPS) ingress rules. Used to detect the pattern
 * where the cluster is healthy but admin endpoints (/argocd, /grafana,
 * /prometheus) are unreachable from an IPv4 address.
 *
 * Root cause pattern (identified 2026-05-02):
 *   adminAllowedIps is built from ALLOW_IPV4/ALLOW_IPV6 env vars at CDK synth.
 *   When cdk-monitoring KubernetesBase was deployed without ALLOW_IPV4 set,
 *   only the IPv6 rule was added — IPv4 admin access silently missing.
 *   Fix: redeploy KubernetesBase stack with ALLOW_IPV4=<admin-cidr>/32.
 *
 * This tool is READ-ONLY. Security group modifications must be done via
 * CDK redeploy — the agent must NOT modify SG rules directly.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - adminCidr (string, optional): expected admin IPv4 CIDR to check presence
 *     (e.g. "37.228.224.56/32"). If provided, flags it explicitly as missing.
 *   - port (number, optional): port to check (default 443)
 *
 * Output:
 *   - securityGroups[]: per-SG id, name, port-443 ingress rules (IPv4 + IPv6)
 *   - missingAdminCidr: true if adminCidr was provided and not found in any SG
 *   - issues[]: human-readable problems
 *   - remediationNote: CDK env vars needed to fix (if issues found)
 */

import {
    EC2Client,
    DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';

import { log } from '@bedrock/shared';

const ec2 = new EC2Client({});

// =============================================================================
// Types
// =============================================================================

export interface CheckSecurityGroupRulesInput {
    readonly adminCidr?: string;
    readonly port?: number;
}

export interface SgIngressRule {
    readonly protocol: string;
    readonly fromPort: number;
    readonly toPort: number;
    readonly cidrIpv4?: string;
    readonly cidrIpv6?: string;
    readonly description?: string;
}

export interface SecurityGroupSummary {
    readonly groupId: string;
    readonly groupName: string;
    readonly vpcId?: string;
    readonly ingressRulesForPort: SgIngressRule[];
    readonly hasIpv4AdminRule: boolean;
    readonly hasIpv6Rule: boolean;
}

export interface SecurityGroupRulesReport {
    readonly securityGroups: SecurityGroupSummary[];
    readonly missingAdminCidr: boolean;
    readonly issues: string[];
    readonly remediationNote?: string;
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(input: CheckSecurityGroupRulesInput): Promise<SecurityGroupRulesReport> {
    const targetPort = input.port ?? 443;

    log('INFO', 'Checking k8s Security Group rules', {
        adminCidr: input.adminCidr,
        port: targetPort,
    });

    // Find all SGs tagged to the k8s project
    const result = await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: [
            { Name: 'tag:Project', Values: ['kubernetes'] },
        ],
    }));

    const sgs = result.SecurityGroups ?? [];

    if (sgs.length === 0) {
        return {
            securityGroups: [],
            missingAdminCidr: !!input.adminCidr,
            issues: ['No security groups found with tag Project=kubernetes'],
            remediationNote: 'Verify the SG tag is set. If recently created, check cdk-monitoring KubernetesBase stack.',
        };
    }

    const summaries: SecurityGroupSummary[] = sgs.map((sg) => {
        const ingressRules = sg.IpPermissions ?? [];

        // Filter to rules that cover the target port
        const rulesForPort = ingressRules
            .filter((rule) => {
                if (rule.IpProtocol === '-1') return true; // all traffic
                const from = rule.FromPort ?? 0;
                const to = rule.ToPort ?? 65535;
                return from <= targetPort && to >= targetPort;
            })
            .flatMap((rule): SgIngressRule[] => {
                const base = {
                    protocol: rule.IpProtocol ?? 'tcp',
                    fromPort: rule.FromPort ?? targetPort,
                    toPort: rule.ToPort ?? targetPort,
                };
                const ipv4Rules = (rule.IpRanges ?? []).map((r): SgIngressRule => ({
                    ...base,
                    cidrIpv4: r.CidrIp,
                    description: r.Description,
                }));
                const ipv6Rules = (rule.Ipv6Ranges ?? []).map((r): SgIngressRule => ({
                    ...base,
                    cidrIpv6: r.CidrIpv6,
                    description: r.Description,
                }));
                return [...ipv4Rules, ...ipv6Rules];
            });

        const hasIpv4AdminRule = input.adminCidr
            ? rulesForPort.some((r) => r.cidrIpv4 === input.adminCidr)
            : rulesForPort.some((r) => !!r.cidrIpv4);

        const hasIpv6Rule = rulesForPort.some((r) => !!r.cidrIpv6);

        return {
            groupId: sg.GroupId ?? 'unknown',
            groupName: sg.GroupName ?? 'unknown',
            vpcId: sg.VpcId,
            ingressRulesForPort: rulesForPort,
            hasIpv4AdminRule,
            hasIpv6Rule,
        };
    });

    const issues: string[] = [];
    let missingAdminCidr = false;

    for (const sg of summaries) {
        if (sg.ingressRulesForPort.length === 0) {
            issues.push(`SG ${sg.groupId} (${sg.groupName}) has NO ingress rules for port ${targetPort}`);
        }
        if (input.adminCidr && !sg.hasIpv4AdminRule) {
            missingAdminCidr = true;
            issues.push(
                `SG ${sg.groupId} (${sg.groupName}) is missing IPv4 rule for ${input.adminCidr} on port ${targetPort}. ` +
                `IPv6 rule present: ${sg.hasIpv6Rule}. ` +
                `This matches the ALLOW_IPV4 missing-at-deploy-time pattern.`,
            );
        }
    }

    let remediationNote: string | undefined;
    if (issues.length > 0) {
        remediationNote =
            'To fix permanently: redeploy cdk-monitoring KubernetesBase stack with ' +
            `ALLOW_IPV4=<admin-ipv4-cidr>/32 set as an environment variable. ` +
            'Do NOT modify SG rules manually via the agent — this is a CDK-managed resource.';
    }

    log('INFO', 'SG check complete', {
        sgCount: summaries.length,
        issueCount: issues.length,
        missingAdminCidr,
    });

    return { securityGroups: summaries, missingAdminCidr, issues, remediationNote };
}
