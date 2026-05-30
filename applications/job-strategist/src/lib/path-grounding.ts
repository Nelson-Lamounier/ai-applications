/**
 * @format
 * Path-grounding verifier (pure).
 *
 * The Strategist agent's analysis prose can cite source-file paths
 * (`infra/lib/**\/*.ts`, `strategist-pipeline-stack.ts`, …). The text-level
 * BedrockGroundingVerifier checks that claim *content* is supported by the
 * retrieved KB chunks, but it never verifies that a cited path actually
 * EXISTS in the ingested repositories. That lets a real-tech / invented-path
 * citation through — e.g. the model reads "admin-api" in documentation prose
 * and emits `api/admin-api/src/**\/*.ts`, a tree that was never ingested.
 *
 * This module is the deterministic guard: given the analysis text and the
 * authoritative set of ingested `document_embeddings.file_path` values, it
 * extracts path-like citations and classifies each as grounded or ungrounded.
 * No LLM, no I/O — trivially testable. The DB loader lives in
 * `path-grounding-loader.ts`; wiring lives in `run-pipeline.ts`.
 */

/**
 * Matches path-like tokens: at least one `/` (e.g. `infra/lib/x.ts`,
 * `infra/lib/**\/*.ts`) OR a bare filename with a known code/doc extension
 * (e.g. `strategist-pipeline-stack.ts`). Globs (`*`, `**`) are allowed inside
 * the segment chars. Deliberately conservative so version strings
 * (`5.9`, `v2.130.0`) and abbreviations (`e.g.`, `i.e.`) are NOT matched.
 */
const PATH_TOKEN = /\b[\w@.-]+(?:\/[\w@.*-]+)+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sql|md|ya?ml|json|toml|sh)\b/g;

/** Extensions that make a slash-free token a plausible filename citation. */
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sql|md|ya?ml|json|toml|sh)$/;

/** Strip trailing punctuation a sentence leaves on a token (`projects.ts,` → `projects.ts`). */
function trimToken(raw: string): string {
    return raw.replace(/[),.;:]+$/, '').trim();
}

/**
 * Extract de-duplicated, path-like citations from free analysis text.
 * Order-preserving (first occurrence wins).
 */
export function extractCitedPaths(text: string): string[] {
    if (!text) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of text.matchAll(PATH_TOKEN)) {
        const tok = trimToken(m[0]);
        if (!tok) continue;
        // A slash-free token only counts if it ends in a known extension —
        // otherwise it's a bare word the regex's filename branch caught.
        if (!tok.includes('/') && !FILE_EXT.test(tok)) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        out.push(tok);
    }
    return out;
}

/** The leading non-glob directory prefix of a (possibly glob) path. */
function nonGlobPrefix(path: string): string {
    const segments = path.split('/');
    const kept: string[] = [];
    for (const seg of segments) {
        if (seg.includes('*')) break;
        kept.push(seg);
    }
    return kept.join('/');
}

/** Final path segment with any glob/extension noise, used for basename match. */
function basename(path: string): string {
    const last = path.split('/').pop() ?? path;
    return last;
}

/**
 * Is a cited path grounded in the ingested file-path set?
 *
 * Matching rules, in order:
 *  1. Exact match.
 *  2. Glob path (`infra/lib/**\/*.ts`): its non-glob prefix is a real
 *     directory prefix of some ingested path AND (if it pins an extension)
 *     that extension appears under the prefix.
 *  3. Bare filename (`strategist-pipeline-stack.ts`, no slash): some ingested
 *     path has that exact basename.
 */
export function isPathGrounded(citation: string, ingested: ReadonlySet<string>): boolean {
    if (ingested.has(citation)) return true;

    const hasGlob = citation.includes('*');
    const hasSlash = citation.includes('/');

    if (hasGlob) {
        const prefix = nonGlobPrefix(citation);
        if (!prefix) return false;
        const extMatch = citation.match(FILE_EXT);
        const ext = extMatch ? extMatch[0] : null;
        for (const real of ingested) {
            if (real === prefix || real.startsWith(`${prefix}/`)) {
                if (!ext || real.endsWith(ext)) return true;
            }
        }
        return false;
    }

    if (!hasSlash) {
        const base = basename(citation);
        for (const real of ingested) {
            if (basename(real) === base) return true;
        }
        return false;
    }

    // Concrete (non-glob) path with slashes that is not an exact member.
    return false;
}

export interface PathClassification {
    readonly grounded: string[];
    readonly ungrounded: string[];
}

/**
 * Extract every cited path from `text` and split into grounded / ungrounded
 * against the authoritative ingested set.
 */
export function classifyCitedPaths(text: string, ingested: ReadonlySet<string>): PathClassification {
    const grounded: string[] = [];
    const ungrounded: string[] = [];
    for (const p of extractCitedPaths(text)) {
        (isPathGrounded(p, ingested) ? grounded : ungrounded).push(p);
    }
    return { grounded, ungrounded };
}
