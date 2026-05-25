/** @format */
import { parseAllDocuments } from 'yaml';
import type { RawTechnologyEvidence } from '../Extractor.js';

/**
 * Parse ArgoCD Application manifests.
 * Emits an 'argocd' token for each Application doc, plus the deployed tool name
 * derived from spec.source.path (charts/<name>/…) or metadata.name as fallback.
 */
export function parseArgoApplication(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    let docs;
    try { docs = parseAllDocuments(src); } catch { return []; }
    for (const d of docs) {
        let obj: Record<string, unknown> | null;
        try { obj = d.toJSON() as Record<string, unknown> | null; } catch { continue; }
        if (!obj) continue;
        const apiVersion = obj['apiVersion'];
        const kind = obj['kind'];
        if (typeof apiVersion !== 'string' || !apiVersion.startsWith('argoproj.io/')) continue;
        if (kind !== 'Application') continue;

        out.push({ raw_name: 'argocd', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });

        // Try to derive tool name from spec.source.path (e.g. charts/traefik/chart)
        const spec = obj['spec'] as Record<string, unknown> | undefined;
        const source = spec?.['source'] as Record<string, unknown> | undefined;
        const sourcePath = source?.['path'];
        let toolName: string | undefined;
        if (typeof sourcePath === 'string') {
            const segments = sourcePath.split('/');
            const chartsIdx = segments.indexOf('charts');
            if (chartsIdx !== -1 && chartsIdx + 1 < segments.length) {
                toolName = segments[chartsIdx + 1];
            }
        }

        // Fallback: metadata.name with common env suffixes stripped
        if (!toolName) {
            const metadata = obj['metadata'] as Record<string, unknown> | undefined;
            const name = metadata?.['name'];
            if (typeof name === 'string') {
                toolName = name
                    .replace(/-eks-development$/, '')
                    .replace(/-production$/, '')
                    .replace(/-development$/, '');
            }
        }

        if (toolName) {
            out.push({ raw_name: toolName, ecosystem: 'argocd', source_layer: 'iac', file_path: filePath });
        }
    }
    return out;
}

/**
 * Parse Helm Chart.yaml files.
 * Emits a 'helm' token plus the chart name and each dependency name.
 */
export function parseHelmChart(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    let doc;
    try {
        const docs = parseAllDocuments(src);
        if (docs.length === 0) return [];
        doc = docs[0].toJSON() as Record<string, unknown> | null;
    } catch { return []; }
    if (!doc) return [];

    const apiVersion = doc['apiVersion'];
    const name = doc['name'];
    // Must look like a Helm Chart.yaml: apiVersion v1/v2 and a name field
    if (typeof apiVersion !== 'string' || (apiVersion !== 'v1' && apiVersion !== 'v2')) return [];
    if (typeof name !== 'string' || !name) return [];

    out.push({ raw_name: 'helm', ecosystem: 'iac', source_layer: 'iac', file_path: filePath });
    out.push({ raw_name: name, ecosystem: 'helm', source_layer: 'iac', file_path: filePath });

    const deps = doc['dependencies'];
    if (Array.isArray(deps)) {
        for (const dep of deps) {
            if (dep && typeof dep === 'object') {
                const depName = (dep as Record<string, unknown>)['name'];
                if (typeof depName === 'string' && depName) {
                    out.push({ raw_name: depName, ecosystem: 'helm', source_layer: 'iac', file_path: filePath });
                }
            }
        }
    }
    return out;
}
