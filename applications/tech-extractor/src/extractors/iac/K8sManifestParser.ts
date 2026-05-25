/** @format */
import { parseAllDocuments } from 'yaml';
import type { RawTechnologyEvidence } from '../Extractor.js';

const K8S_KINDS = new Set([
    'Deployment','StatefulSet','DaemonSet','Job','CronJob','Service','Ingress','Pod',
]);

/** Detect k8s manifests; emit a 'kubernetes' token + each container image name. */
export function parseK8sManifest(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    let isK8s = false;
    for (const d of docs) {
        const obj = d.toJSON() as { kind?: string } | null;
        if (obj?.kind && K8S_KINDS.has(obj.kind)) {
            isK8s = true;
            for (const img of collectImages(obj)) {
                const name = img.split('@')[0].split(':')[0].split('/').pop()!;
                out.push({ raw_name: name, ecosystem: 'docker', source_layer: 'iac', file_path: filePath });
            }
        }
    }
    if (isK8s) out.unshift({ raw_name: 'kubernetes', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    return out;
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
