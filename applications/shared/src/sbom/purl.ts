/** @format */

export interface PurlInput {
    /** The technology_evidence `ecosystem` (npm, docker, pypi, …) or a raw type. */
    readonly ecosystem: string;
    /** Raw package/technology name. */
    readonly name: string;
    /** Optional version (technology_evidence does not capture it today). */
    readonly version?: string;
}

/**
 * PURL `type` values we map ecosystems onto directly (per the purl-spec type
 * list). Anything else — including non-package signals like `aws`, `terraform`,
 * or an empty ecosystem — falls back to `generic`.
 */
const KNOWN_PURL_TYPES = new Set([
    'npm', 'pypi', 'gem', 'cargo', 'golang', 'maven', 'nuget',
    'composer', 'docker', 'deb', 'rpm', 'apk', 'conan', 'hex', 'pub', 'swift', 'generic',
]);

function purlType(ecosystem: string): string {
    const eco = ecosystem.trim().toLowerCase();
    return KNOWN_PURL_TYPES.has(eco) ? eco : 'generic';
}

/**
 * Build a Package URL (purl) string from an evidence row's ecosystem + name.
 * See https://github.com/package-url/purl-spec. Version is optional.
 */
export function toPurl(input: PurlInput): string {
    const type = purlType(input.ecosystem);
    // Percent-encode the scope `@` (npm `@scope/name` → `%40scope/name`) while
    // keeping `/` as the namespace/name separator, per the purl-spec.
    const name = input.name.replaceAll('@', '%40');
    const version = input.version ? `@${input.version}` : '';
    return `pkg:${type}/${name}${version}`;
}
