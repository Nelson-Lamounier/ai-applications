/**
 * @format
 * Inspect Workloads — MCP Tool Lambda
 *
 * Runs five parallel kubectl queries in a single SSM command to build a
 * comprehensive cluster health snapshot without multiple SSM round-trips:
 *
 *   1. kubectl get nodes         — Ready / NotReady counts + conditions
 *   2. kubectl get daemonsets -A — desired vs ready per DS (critical for Traefik, Calico)
 *   3. kubectl get deployments -A — desired vs available replicas
 *   4. kubectl get statefulsets -A — desired vs ready replicas
 *   5. kubectl get events -A (Warning only, last 50) — CrashLoopBackOff, OOMKilled,
 *      ImagePullBackOff, FailedScheduling, BackOff
 *
 * All five queries run as background jobs on the control plane via `wait`, so
 * total SSM time ≈ slowest query (~3–5s), not the sum (~15s).
 *
 * Use this tool to answer:
 * - Is Traefik running on all nodes?
 * - Which deployments are under-replicated?
 * - What caused recent pod failures?
 * - Are any nodes reporting disk pressure / memory pressure?
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - namespaces (string[], optional): limit output to these namespaces
 *   - maxEvents (number, optional): cap Warning events returned (default 50)
 *
 * Output:
 *   - controlPlaneInstanceId
 *   - nodes: { total, ready, notReady, items[] }
 *   - daemonSets[]: per-DS desired / current / ready / misscheduled
 *   - deployments[]: per-Deployment desired / available / ready
 *   - statefulSets[]: per-STS desired / ready
 *   - events[]: recent Warning events sorted by lastTimestamp desc
 *   - clusterHealthy: true only when all nodes Ready AND all workloads at desired capacity
 *   - summary: human-readable bullet list of the most important findings
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

const SSM_POLL_TIMEOUT_MS = 75_000;
const SSM_POLL_INTERVAL_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

export interface InspectWorkloadsInput {
    readonly namespaces?: string[];
    readonly maxEvents?: number;
}

export interface NodeSummary {
    readonly name: string;
    readonly status: 'Ready' | 'NotReady' | 'Unknown';
    readonly roles: string[];
    readonly kubeletVersion: string;
    readonly conditions: Array<{
        readonly type: string;
        readonly status: string;
        readonly reason?: string;
        readonly message?: string;
    }>;
}

export interface DaemonSetStatus {
    readonly name: string;
    readonly namespace: string;
    readonly desired: number;
    readonly current: number;
    readonly ready: number;
    readonly available: number;
    readonly misscheduled: number;
    readonly healthy: boolean;
}

export interface DeploymentStatus {
    readonly name: string;
    readonly namespace: string;
    readonly desired: number;
    readonly ready: number;
    readonly available: number;
    readonly upToDate: number;
    readonly healthy: boolean;
}

export interface StatefulSetStatus {
    readonly name: string;
    readonly namespace: string;
    readonly desired: number;
    readonly ready: number;
    readonly healthy: boolean;
}

export interface ClusterEvent {
    readonly namespace: string;
    readonly involvedObjectKind: string;
    readonly involvedObjectName: string;
    readonly reason: string;
    readonly message: string;
    readonly count: number;
    readonly lastTimestamp: string;
    readonly firstTimestamp: string;
}

export interface WorkloadInspectionReport {
    readonly controlPlaneInstanceId: string;
    readonly clusterHealthy: boolean;
    readonly nodes: {
        readonly total: number;
        readonly ready: number;
        readonly notReady: number;
        readonly items: NodeSummary[];
    };
    readonly daemonSets: DaemonSetStatus[];
    readonly deployments: DeploymentStatus[];
    readonly statefulSets: StatefulSetStatus[];
    readonly events: ClusterEvent[];
    readonly summary: string[];
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
            TimeoutSeconds: 70,
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
                return invocation.StandardOutputContent?.trim() ?? undefined;
            }
            if (invocation.Status === 'Failed' || invocation.Status === 'Cancelled') {
                log('ERROR', 'SSM command failed', {
                    commandId,
                    status: invocation.Status,
                    stderr: invocation.StandardErrorContent?.trim(),
                });
                return undefined;
            }
        } catch {
            // InvocationDoesNotExist — still pending
        }
    }
    log('ERROR', 'SSM command timed out', { commandId, timeoutMs: SSM_POLL_TIMEOUT_MS });
    return undefined;
}

/**
 * Build the bash+Python script that runs all kubectl queries in parallel.
 *
 * All five kubectl calls run as background jobs and are collected with `wait`.
 * Python processes each result file into a single combined JSON payload.
 * The Python script is written to a tmpfile (not a heredoc) so no bash
 * variable expansion occurs inside the Python source.
 */
function buildInspectScript(maxEvents: number): string {
    // The Python source is written separately to avoid heredoc quoting issues.
    // Single-quote the heredoc delimiter so bash does NOT expand $vars inside.
    return `
set -euo pipefail
TMP=$(mktemp -d /tmp/sh_inspect_XXXXX)
trap 'rm -rf "$TMP"' EXIT

export KUBECONFIG=/etc/kubernetes/admin.conf
export HOME=/root

# Run all five queries in parallel
kubectl get nodes -o json > "$TMP/nodes.json" 2>/dev/null &
kubectl get daemonsets -A -o json > "$TMP/ds.json" 2>/dev/null &
kubectl get deployments -A -o json > "$TMP/deploy.json" 2>/dev/null &
kubectl get statefulsets -A -o json > "$TMP/sts.json" 2>/dev/null &
kubectl get events -A --sort-by='.lastTimestamp' \\
  --field-selector='type=Warning' -o json > "$TMP/events.json" 2>/dev/null &
wait

# Write the processing script to a temp file (avoids heredoc variable expansion)
cat > "$TMP/process.py" << 'PYEOF'
import json, sys, os

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {"items": []}

def node_status(conditions):
    for c in conditions:
        if c.get("type") == "Ready":
            return "Ready" if c.get("status") == "True" else "NotReady"
    return "Unknown"

def extract_roles(labels):
    roles = [k.replace("node-role.kubernetes.io/", "")
             for k in labels if k.startswith("node-role.kubernetes.io/")]
    return roles or ["worker"]

tmp = sys.argv[1]
max_events = int(sys.argv[2])

nodes_raw = load(f"{tmp}/nodes.json")
ds_raw    = load(f"{tmp}/ds.json")
dep_raw   = load(f"{tmp}/deploy.json")
sts_raw   = load(f"{tmp}/sts.json")
ev_raw    = load(f"{tmp}/events.json")

# ── Nodes ──────────────────────────────────────────────────────────────────
node_items = []
for n in nodes_raw.get("items", []):
    meta = n.get("metadata", {})
    status = n.get("status", {})
    conds  = status.get("conditions", [])
    addrs  = status.get("addresses", [])
    node_items.append({
        "name":          meta.get("name", "unknown"),
        "status":        node_status(conds),
        "roles":         extract_roles(meta.get("labels", {})),
        "kubeletVersion": status.get("nodeInfo", {}).get("kubeletVersion", "unknown"),
        "conditions": [
            {
                "type":    c.get("type", ""),
                "status":  c.get("status", ""),
                "reason":  c.get("reason"),
                "message": c.get("message"),
            }
            for c in conds
        ],
    })

total_nodes    = len(node_items)
ready_nodes    = sum(1 for n in node_items if n["status"] == "Ready")
notready_nodes = total_nodes - ready_nodes

# ── DaemonSets ─────────────────────────────────────────────────────────────
ds_items = []
for d in ds_raw.get("items", []):
    meta = d.get("metadata", {})
    s    = d.get("status", {})
    desired      = s.get("desiredNumberScheduled", 0)
    current      = s.get("currentNumberScheduled", 0)
    ready        = s.get("numberReady", 0)
    available    = s.get("numberAvailable", 0)
    misscheduled = s.get("numberMisscheduled", 0)
    ds_items.append({
        "name":         meta.get("name", "unknown"),
        "namespace":    meta.get("namespace", "unknown"),
        "desired":      desired,
        "current":      current,
        "ready":        ready,
        "available":    available,
        "misscheduled": misscheduled,
        "healthy":      desired > 0 and ready == desired and misscheduled == 0,
    })

# ── Deployments ────────────────────────────────────────────────────────────
dep_items = []
for d in dep_raw.get("items", []):
    meta = d.get("metadata", {})
    spec = d.get("spec", {})
    s    = d.get("status", {})
    desired   = spec.get("replicas", 0)
    ready     = s.get("readyReplicas", 0)
    available = s.get("availableReplicas", 0)
    upToDate  = s.get("updatedReplicas", 0)
    dep_items.append({
        "name":      meta.get("name", "unknown"),
        "namespace": meta.get("namespace", "unknown"),
        "desired":   desired,
        "ready":     ready,
        "available": available,
        "upToDate":  upToDate,
        "healthy":   desired > 0 and available >= desired,
    })

# ── StatefulSets ───────────────────────────────────────────────────────────
sts_items = []
for s in sts_raw.get("items", []):
    meta    = s.get("metadata", {})
    spec    = s.get("spec", {})
    status  = s.get("status", {})
    desired = spec.get("replicas", 0)
    ready   = status.get("readyReplicas", 0)
    sts_items.append({
        "name":      meta.get("name", "unknown"),
        "namespace": meta.get("namespace", "unknown"),
        "desired":   desired,
        "ready":     ready,
        "healthy":   desired > 0 and ready >= desired,
    })

# ── Events ─────────────────────────────────────────────────────────────────
ev_items_raw = ev_raw.get("items", [])
# Sort descending by lastTimestamp (most recent first)
ev_items_raw.sort(
    key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "",
    reverse=True,
)
ev_items = []
for e in ev_items_raw[:max_events]:
    obj = e.get("involvedObject", {})
    ev_items.append({
        "namespace":           e.get("metadata", {}).get("namespace", ""),
        "involvedObjectKind":  obj.get("kind", ""),
        "involvedObjectName":  obj.get("name", ""),
        "reason":              e.get("reason", ""),
        "message":             e.get("message", ""),
        "count":               e.get("count", 1),
        "lastTimestamp":       e.get("lastTimestamp") or e.get("eventTime") or "",
        "firstTimestamp":      e.get("firstTimestamp") or "",
    })

# ── Summary bullets ────────────────────────────────────────────────────────
summary = []

if notready_nodes > 0:
    names = [n["name"] for n in node_items if n["status"] != "Ready"]
    summary.append(f"NODES: {notready_nodes}/{total_nodes} NotReady — {', '.join(names)}")

unhealthy_ds = [d for d in ds_items if not d["healthy"]]
for d in unhealthy_ds:
    summary.append(
        f"DAEMONSET {d['namespace']}/{d['name']}: "
        f"{d['ready']}/{d['desired']} ready"
        + (f", {d['misscheduled']} misscheduled" if d['misscheduled'] else "")
    )

unhealthy_dep = [d for d in dep_items if not d["healthy"]]
for d in unhealthy_dep:
    summary.append(
        f"DEPLOYMENT {d['namespace']}/{d['name']}: "
        f"{d['available']}/{d['desired']} available"
    )

unhealthy_sts = [s for s in sts_items if not s["healthy"]]
for s in unhealthy_sts:
    summary.append(
        f"STATEFULSET {s['namespace']}/{s['name']}: "
        f"{s['ready']}/{s['desired']} ready"
    )

# Deduplicated top event reasons
seen_reasons = set()
for e in ev_items[:10]:
    key = f"{e['reason']}/{e['namespace']}/{e['involvedObjectName']}"
    if key not in seen_reasons:
        seen_reasons.add(key)
        summary.append(
            f"EVENT {e['reason']} — {e['namespace']}/{e['involvedObjectName']}: "
            f"{e['message'][:120]}"
        )

if not summary:
    summary.append("Cluster healthy: all nodes Ready, all workloads at desired capacity, no Warning events")

result = {
    "nodes":       {"total": total_nodes, "ready": ready_nodes, "notReady": notready_nodes, "items": node_items},
    "daemonSets":  ds_items,
    "deployments": dep_items,
    "statefulSets": sts_items,
    "events":      ev_items,
    "summary":     summary,
    "clusterHealthy": (
        notready_nodes == 0
        and len(unhealthy_ds) == 0
        and len(unhealthy_dep) == 0
        and len(unhealthy_sts) == 0
    ),
}
print(json.dumps(result))
PYEOF

python3 "$TMP/process.py" "$TMP" ${maxEvents}
`.trim();
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(event: InspectWorkloadsInput): Promise<WorkloadInspectionReport> {
    const maxEvents = event.maxEvents ?? 50;
    const nsFilter = event.namespaces ?? [];

    log('INFO', 'Inspecting cluster workloads', { namespaces: nsFilter, maxEvents });

    // Resolve control plane
    let cpInstanceId: string;
    try {
        const id = await resolveControlPlaneInstance();
        if (!id) {
            return {
                controlPlaneInstanceId: 'unknown',
                clusterHealthy: false,
                nodes: { total: 0, ready: 0, notReady: 0, items: [] },
                daemonSets: [],
                deployments: [],
                statefulSets: [],
                events: [],
                summary: [],
                error: 'No running control-plane instance found (tag k8s:bootstrap-role=control-plane)',
            };
        }
        cpInstanceId = id;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            controlPlaneInstanceId: 'unknown',
            clusterHealthy: false,
            nodes: { total: 0, ready: 0, notReady: 0, items: [] },
            daemonSets: [],
            deployments: [],
            statefulSets: [],
            events: [],
            summary: [],
            error: `Failed to resolve control plane: ${error}`,
        };
    }

    log('INFO', 'Control plane resolved', { cpInstanceId });

    const script = buildInspectScript(maxEvents);

    let rawOutput: string | undefined;
    try {
        rawOutput = await ssmExec(cpInstanceId, script);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            controlPlaneInstanceId: cpInstanceId,
            clusterHealthy: false,
            nodes: { total: 0, ready: 0, notReady: 0, items: [] },
            daemonSets: [],
            deployments: [],
            statefulSets: [],
            events: [],
            summary: [],
            error: `SSM execution failed: ${error}`,
        };
    }

    if (!rawOutput) {
        return {
            controlPlaneInstanceId: cpInstanceId,
            clusterHealthy: false,
            nodes: { total: 0, ready: 0, notReady: 0, items: [] },
            daemonSets: [],
            deployments: [],
            statefulSets: [],
            events: [],
            summary: [],
            error: 'kubectl inspection script returned no output (SSM timed out or failed)',
        };
    }

    let parsed: {
        nodes: WorkloadInspectionReport['nodes'];
        daemonSets: DaemonSetStatus[];
        deployments: DeploymentStatus[];
        statefulSets: StatefulSetStatus[];
        events: ClusterEvent[];
        summary: string[];
        clusterHealthy: boolean;
    };

    try {
        // The script may emit log lines before the JSON. Find the JSON object.
        const jsonStart = rawOutput.lastIndexOf('{');
        const jsonStr = jsonStart >= 0 ? rawOutput.slice(jsonStart) : rawOutput;
        parsed = JSON.parse(jsonStr);
    } catch {
        return {
            controlPlaneInstanceId: cpInstanceId,
            clusterHealthy: false,
            nodes: { total: 0, ready: 0, notReady: 0, items: [] },
            daemonSets: [],
            deployments: [],
            statefulSets: [],
            events: [],
            summary: [],
            error: `Failed to parse inspection output: ${rawOutput.slice(0, 300)}`,
        };
    }

    // Apply optional namespace filter
    function nsFilterFn<T extends { namespace: string }>(items: T[]): T[] {
        return nsFilter.length > 0 ? items.filter((i) => nsFilter.includes(i.namespace)) : items;
    }

    const result: WorkloadInspectionReport = {
        controlPlaneInstanceId: cpInstanceId,
        clusterHealthy: parsed.clusterHealthy,
        nodes: parsed.nodes,
        daemonSets: nsFilterFn(parsed.daemonSets),
        deployments: nsFilterFn(parsed.deployments),
        statefulSets: nsFilterFn(parsed.statefulSets),
        events: nsFilterFn(parsed.events),
        summary: parsed.summary,
    };

    log('INFO', 'Workload inspection complete', {
        clusterHealthy: result.clusterHealthy,
        totalNodes: result.nodes.total,
        readyNodes: result.nodes.ready,
        unhealthyDs: result.daemonSets.filter((d) => !d.healthy).length,
        unhealthyDep: result.deployments.filter((d) => !d.healthy).length,
        warningEvents: result.events.length,
        summaryLines: result.summary.length,
    });

    return result;
}
