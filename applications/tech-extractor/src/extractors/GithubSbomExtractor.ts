/** @format */
import type { RawTechnologyEvidence } from './Extractor.js';

// GitHub's dependency-graph SBOM is repo-level (not file-cited), so evidence
// rows carry this sentinel path rather than a real location.
const GH_SBOM_FILE = '(github-dependency-graph)';

interface SpdxExternalRef { referenceType?: string; referenceLocator?: string }
interface SpdxPackage { name?: string; versionInfo?: string; externalRefs?: SpdxExternalRef[] }
interface GithubSbomDoc { sbom?: { packages?: SpdxPackage[] } }

/**
 * Parse a Package URL into its ecosystem (purl type), name, and optional
 * version. Minimal — covers the `pkg:type/namespace/name@version` shape GitHub
 * emits (npm scopes are `%40`-encoded; qualifiers/subpath are stripped).
 */
function fromPurl(purl: string): { ecosystem: string; name: string; version?: string } | null {
    if (!purl.startsWith('pkg:')) return null;
    const body = purl.slice(4).split('?')[0]!.split('#')[0]!;
    const slash = body.indexOf('/');
    if (slash < 0) return null;
    const ecosystem = body.slice(0, slash);
    let rest = body.slice(slash + 1);
    let version: string | undefined;
    const at = rest.lastIndexOf('@');
    if (at > 0) { version = rest.slice(at + 1); rest = rest.slice(0, at); }
    const name = rest.replaceAll('%40', '@');
    return name ? { ecosystem, name, version } : null;
}

/**
 * Pure parser — maps a GitHub dependency-graph SBOM (SPDX JSON, as returned by
 * `GET /repos/{o}/{r}/dependency-graph/sbom`) to `github-sbom` evidence rows.
 * Each package is identified via its `purl` external ref; packages without one
 * (e.g. the root document package describing the repo) are skipped. The live
 * fetch is a separate concern (the extractor client) — this stays unit-testable
 * without the network, mirroring `parseSyftJson`.
 */
export function parseGithubSpdx(json: string): RawTechnologyEvidence[] {
    let doc: GithubSbomDoc;
    try { doc = JSON.parse(json); } catch { return []; }
    const out: RawTechnologyEvidence[] = [];
    for (const p of doc.sbom?.packages ?? []) {
        const locator = p.externalRefs?.find(r => r.referenceType === 'purl' && r.referenceLocator)?.referenceLocator;
        if (!locator) continue;
        const parsed = fromPurl(locator);
        if (!parsed) continue;
        out.push({
            raw_name:     parsed.name,
            ecosystem:    parsed.ecosystem,
            source_layer: 'github-sbom',
            file_path:    GH_SBOM_FILE,
            ...(parsed.version ? { version: parsed.version } : {}),
        });
    }
    return out;
}
