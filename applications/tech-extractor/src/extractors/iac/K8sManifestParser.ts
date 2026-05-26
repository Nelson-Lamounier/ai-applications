/** @format */
import { parseAllDocuments } from 'yaml';
import type { RawTechnologyEvidence } from '../Extractor.js';
import { scanArns } from './ArnScanner.js';
import { scanEcrUris } from './EcrUriScanner.js';

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

export function parseK8sManifestValues(src: string, filePath: string): RawTechnologyEvidence[] {
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    const allStrings: string[] = [];
    for (const d of docs) {
        let obj: unknown;
        try { obj = d.toJSON(); } catch { continue; }
        collectStringValues(obj, allStrings);
    }
    if (allStrings.length === 0) return [];
    const joined = allStrings.join('\n');
    return [...scanArns(joined, filePath), ...scanEcrUris(joined, filePath)];
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
