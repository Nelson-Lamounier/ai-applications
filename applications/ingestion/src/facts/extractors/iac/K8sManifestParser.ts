/** @format */
import { parseAllDocuments } from 'yaml';
import type { RawTechnologyEvidence } from '../Extractor.js';
import { scanArns } from './ArnScanner.js';
import { scanEcrUris } from './EcrUriScanner.js';

const K8S_KINDS = new Set([
    'Deployment','StatefulSet','DaemonSet','Job','CronJob','Service','Ingress','Pod',
    // S3: security/networking kinds — recognised as k8s so manifests without a workload
    // still register, and each emits a distinct DevOps networking/security token below.
    'NetworkPolicy','Role','RoleBinding','ClusterRole','ClusterRoleBinding',
]);

/** RBAC kinds → a single 'k8s_rbac' DevOps security token (resolves via migration 060). */
const RBAC_KINDS = new Set(['Role','RoleBinding','ClusterRole','ClusterRoleBinding']);

/** Detect k8s manifests; emit a 'kubernetes' token + each container image name. */
export function parseK8sManifest(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    let isK8s = false;
    const emitted = new Set<string>();   // dedup distinct DevOps tokens within one file
    for (const d of docs) {
        const obj = d.toJSON() as { kind?: string } | null;
        if (obj?.kind && K8S_KINDS.has(obj.kind)) {
            isK8s = true;
            if (obj.kind === 'NetworkPolicy' && !emitted.has('k8s_networkpolicy')) {
                emitted.add('k8s_networkpolicy');
                out.push({ raw_name: 'k8s_networkpolicy', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
            }
            if (RBAC_KINDS.has(obj.kind) && !emitted.has('k8s_rbac')) {
                emitted.add('k8s_rbac');
                out.push({ raw_name: 'k8s_rbac', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
            }
            for (const img of collectImages(obj)) {
                const name = img.split('@')[0].split(':')[0].split('/').pop()!;
                out.push({ raw_name: name, ecosystem: 'docker', source_layer: 'iac', file_path: filePath });
            }
        }
    }
    if (isK8s) out.unshift({ raw_name: 'kubernetes', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
}

const ANNOTATION_KEY_ALLOWLIST: Array<{ prefix: string; canonical: string }> = [
    { prefix: 'eks.amazonaws.com/', canonical: 'aws_eks' },
    { prefix: 'iam.amazonaws.com/', canonical: 'aws_iam' },
    { prefix: 'service.beta.kubernetes.io/aws-load-balancer-', canonical: 'aws_load_balancer_controller' },
];

export function parseK8sManifestValues(src: string, filePath: string): RawTechnologyEvidence[] {
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    const allStrings: string[] = [];
    const parsedDocs: unknown[] = [];
    for (const d of docs) {
        let obj: unknown;
        try { obj = d.toJSON(); } catch { continue; }
        parsedDocs.push(obj);
        collectStringValues(obj, allStrings);
    }
    const annotationRows = scanK8sAnnotationKeys(parsedDocs, filePath);
    if (allStrings.length === 0 && annotationRows.length === 0) return [];
    const joined = allStrings.join('\n');
    const merged = [
        ...scanArns(joined, filePath),
        ...scanEcrUris(joined, filePath),
        ...annotationRows,
    ];
    const seen = new Set<string>();
    const out: RawTechnologyEvidence[] = [];
    for (const row of merged) {
        if (seen.has(row.raw_name)) continue;
        seen.add(row.raw_name);
        out.push(row);
    }
    return out;
}

function scanK8sAnnotationKeys(docs: unknown[], filePath: string): RawTechnologyEvidence[] {
    const seen = new Set<string>();
    const out: RawTechnologyEvidence[] = [];
    for (const obj of docs) {
        if (!obj || typeof obj !== 'object') continue;
        const annotationMaps: unknown[] = [];
        const meta = (obj as Record<string, unknown>).metadata;
        if (meta && typeof meta === 'object') {
            annotationMaps.push((meta as Record<string, unknown>).annotations);
        }
        const spec = (obj as Record<string, unknown>).spec;
        if (spec && typeof spec === 'object') {
            const template = (spec as Record<string, unknown>).template;
            if (template && typeof template === 'object') {
                const tMeta = (template as Record<string, unknown>).metadata;
                if (tMeta && typeof tMeta === 'object') {
                    annotationMaps.push((tMeta as Record<string, unknown>).annotations);
                }
            }
        }
        for (const map of annotationMaps) {
            if (!map || typeof map !== 'object') continue;
            for (const key of Object.keys(map as Record<string, unknown>)) {
                for (const { prefix, canonical } of ANNOTATION_KEY_ALLOWLIST) {
                    if (key.startsWith(prefix) && !seen.has(canonical)) {
                        seen.add(canonical);
                        out.push({ raw_name: canonical, ecosystem: 'k8s-annotation', source_layer: 'iac', file_path: filePath });
                    }
                }
            }
        }
    }
    return out;
}

function collectStringValues(node: unknown, out: string[]): void {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(n => collectStringValues(n, out)); return; }
    if (node && typeof node === 'object') for (const v of Object.values(node)) collectStringValues(v, out);
}

function collectImages(node: unknown): string[] {
    const images: string[] = [];
    (function rec(n: unknown): void {
        if (Array.isArray(n)) { n.forEach(rec); return; }
        if (n && typeof n === 'object') {
            for (const [k, v] of Object.entries(n)) {
                if (k === 'image' && typeof v === 'string') images.push(v);
                else rec(v);
            }
        }
    })(node);
    return images;
}
