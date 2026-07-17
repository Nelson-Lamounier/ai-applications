/** @format */
import type { Extractor, RawTechnologyEvidence } from './Extractor.js';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // SBOM JSON for a large dep tree
const DEFAULT_TIMEOUT_MS = 20_000;

export interface GithubSbomOptions {
    readonly maxBytes?:  number;
    readonly timeoutMs?: number;
    /** Injectable for tests; defaults to the global fetch. */
    readonly fetchImpl?: typeof fetch;
}

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
    if (at > 0) { version = safeDecode(rest.slice(at + 1)); rest = rest.slice(0, at); }
    const name = safeDecode(rest);
    return name ? { ecosystem, name, version } : null;
}

/** Percent-decode a purl segment (e.g. npm scope %40→@, version range %2A→*). */
function safeDecode(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Live lane: fetch the GitHub dependency-graph SBOM and parse it. A
 * zero-compute cross-check/fallback to Syft — declared deps straight from
 * GitHub's graph (no Syft scan). Best-effort: a throw here is recorded as a
 * failed lane by the orchestrator and never fails the run. Network adapter
 * obeys the repo guardrail — request timeout + response-size cap.
 */
export class GithubSbomExtractor implements Extractor {
    readonly name = 'github-sbom';
    private readonly maxBytes:  number;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(
        private readonly repoFullName: string,
        private readonly token: string,
        opts: GithubSbomOptions = {},
    ) {
        this.maxBytes  = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async extract(_rootDir: string): Promise<RawTechnologyEvidence[]> {
        const url = `https://api.github.com/repos/${this.repoFullName}/dependency-graph/sbom`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(url, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept:        'application/vnd.github+json',
                    'User-Agent':  'tucaken-tech-extractor',
                },
                signal: ctrl.signal,
            });
            // 404 = this repo has no dependency-graph SBOM (feature off / private
            // repo without it enabled). A normal "no data" outcome, not a failure
            // — return empty so the lane isn't flagged failed. Other non-ok
            // statuses (403 permission, 5xx) throw so they surface.
            if (res.status === 404) return [];
            if (!res.ok) throw new Error(`github sbom fetch failed: HTTP ${res.status}`);
            const len = Number(res.headers.get('content-length') ?? '0');
            if (len > this.maxBytes) throw new Error(`github_sbom_too_large: ${len} > ${this.maxBytes}`);
            const text = await res.text();
            if (text.length > this.maxBytes) throw new Error(`github_sbom_too_large: streamed > ${this.maxBytes}`);
            return parseGithubSpdx(text);
        } finally {
            clearTimeout(timer);
        }
    }
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
