/** @format */
import { toPurl } from './purl.js';

/** The fields of a `technology_evidence` row the SBOM mapper needs. */
export interface EvidenceComponentInput {
    readonly rawName: string;
    readonly ecosystem: string | null;
    readonly version?: string;
}

/** A component to place in the CycloneDX `components[]` array. */
export interface SbomComponent {
    readonly name: string;
    readonly purl: string;
    readonly version?: string;
}

/** Minimal CycloneDX 1.6 component shape we emit. */
interface CycloneDxComponent {
    readonly type: 'library';
    readonly name: string;
    readonly purl: string;
    readonly version?: string;
}

/** The BOM's subject — the repository the SBOM describes. */
interface CycloneDxSubject {
    readonly type: 'application';
    readonly name: string;
    readonly version?: string;
}

/** The subset of a CycloneDX 1.6 BOM document we produce. */
export interface CycloneDxBom {
    readonly bomFormat: 'CycloneDX';
    readonly specVersion: '1.6';
    readonly version: number;
    readonly metadata: { readonly component: CycloneDxSubject };
    readonly components: CycloneDxComponent[];
}

export interface BomMeta {
    readonly repoFullName: string;
    readonly commitSha?: string;
}

/**
 * Map `technology_evidence` rows to SBOM components, deduped by purl. The same
 * technology cited in many files collapses to one component; first occurrence
 * wins (and carries a version if one was captured). Order is preserved.
 */
export function technologyEvidenceToComponents(rows: readonly EvidenceComponentInput[]): SbomComponent[] {
    const byPurl = new Map<string, SbomComponent>();
    for (const row of rows) {
        const purl = toPurl({ ecosystem: row.ecosystem ?? '', name: row.rawName, version: row.version });
        if (byPurl.has(purl)) continue;
        byPurl.set(purl, {
            name: row.rawName,
            purl,
            ...(row.version ? { version: row.version } : {}),
        });
    }
    return [...byPurl.values()];
}

const GENERIC_PREFIX = 'pkg:generic/';

/**
 * Collapse cross-lane duplicates: the same tool can surface as both a
 * package-ecosystem purl (e.g. `pkg:npm/cdk-nag` from Syft) and a `generic`
 * purl (e.g. `pkg:generic/cdk-nag` from tree-sitter). Drop the generic variant
 * when a more specific one exists for the same name; keep generics that have no
 * specific counterpart. Order preserved.
 */
export function preferSpecificPurls(components: SbomComponent[]): SbomComponent[] {
    const namesWithSpecific = new Set(
        components.filter(c => !c.purl.startsWith(GENERIC_PREFIX)).map(c => c.name),
    );
    return components.filter(c => !(c.purl.startsWith(GENERIC_PREFIX) && namesWithSpecific.has(c.name)));
}

/** Wrap SBOM components in a CycloneDX 1.6 envelope. Pure — no clock/IO. */
export function buildCycloneDxBom(components: SbomComponent[], meta: BomMeta): CycloneDxBom {
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
            component: {
                type: 'application',
                name: meta.repoFullName,
                ...(meta.commitSha ? { version: meta.commitSha } : {}),
            },
        },
        components: components.map(c => ({
            type: 'library',
            name: c.name,
            purl: c.purl,
            ...(c.version ? { version: c.version } : {}),
        })),
    };
}
