/**
 * @format
 * SBOM-ground the case-study stack.
 *
 * The case-study agent (Sonnet) drafts `stack[]` from LLM-extracted profile
 * tech tags + prose — names without versions, and free to name a tech the code
 * never actually declares. This module closes that gap deterministically using
 * the tech-extractor's `technology_evidence` lane (Syft/treesitter/IaC/Docker),
 * which already carries the REAL dependency version + canonical purl + the
 * declaration file:line (migrations 089/090).
 *
 * Two pure operations, both server-side (the model never fills these):
 *   - buildVerifiedStackMap: collapse evidence rows to one entry per canonical,
 *     preferring the version-bearing row (a fully-qualified `name@version` purl).
 *   - stampStackSignals: for one generated stack item, stamp `verifiedTech` onto
 *     its sourceSignals when its name matches a code dependency; when it matches
 *     nothing AND carries no other evidence, flag it (NOT_GROUNDED + an
 *     ungrounded claim) so an invented dependency is visible, never silently
 *     trusted. A match never weakens grounding; an already-GROUNDED row is left
 *     alone.
 *
 * Stored in `source_signals` JSONB (the designated evidence trail) — additive,
 * no schema migration, mirroring the tech-extractor's metadata-stamp pattern.
 */
import { normalizeAlias } from '../../rds/ontology/OntologyResolver.js';
import type { SourceSignal } from './case-study-types.js';

/** One `technology_evidence` row (joined to its canonical name) for a project. */
export interface VerifiedTechRow {
    readonly canonicalName: string;
    readonly version:       string | null;
    readonly purl:          string | null;
    readonly filePath:      string | null;
    readonly lineStart:     number | null;
}

/** The collapsed, citeable identity of one canonical dependency. */
export interface VerifiedTechEntry {
    readonly canonical: string;
    readonly version:   string | null;
    readonly purl:      string | null;
    readonly path:      string | null;
    readonly line:      number | null;
}

/** The shape stamped into `source_signals.verifiedTech` (one per stack item). */
export interface VerifiedTechStamp {
    readonly name:    string;
    readonly version: string | null;
    readonly purl:    string | null;
    readonly path:    string | null;
    readonly line:    number | null;
}

/**
 * Collapse evidence rows to one entry per canonical (keyed by the normalised
 * canonical name). When a canonical appears on multiple lanes, the version-
 * bearing row wins (a `name@version` purl is strictly more useful than a bare
 * one); ties break to the earliest declaration line.
 */
export function buildVerifiedStackMap(rows: readonly VerifiedTechRow[]): Map<string, VerifiedTechEntry> {
    const map = new Map<string, VerifiedTechEntry>();
    for (const r of rows) {
        const key = normalizeAlias(r.canonicalName);
        if (key.length === 0) continue;
        const next: VerifiedTechEntry = {
            canonical: r.canonicalName,
            version:   r.version,
            purl:      r.purl,
            path:      r.filePath,
            line:      r.lineStart,
        };
        const prev = map.get(key);
        if (!prev || isBetter(next, prev)) map.set(key, next);
    }
    return map;
}

/** Prefer a version-bearing entry; among equals, the earliest declaration line. */
function isBetter(next: VerifiedTechEntry, prev: VerifiedTechEntry): boolean {
    const nextHasVersion = next.version != null;
    const prevHasVersion = prev.version != null;
    if (nextHasVersion !== prevHasVersion) return nextHasVersion;
    const nextLine = next.line ?? Number.MAX_SAFE_INTEGER;
    const prevLine = prev.line ?? Number.MAX_SAFE_INTEGER;
    return nextLine < prevLine;
}

/** True when the signal already cites any commit / PR / file evidence. */
function hasOtherEvidence(s: SourceSignal): boolean {
    return s.commits.length > 0 || s.pulls.length > 0 || s.files.length > 0;
}

/**
 * Stamp a stack item's sourceSignals with its verified code-dependency identity,
 * or flag it when it grounds to nothing. Pure: returns a new SourceSignal.
 */
export function stampStackSignals(
    name: string,
    signals: SourceSignal,
    map: ReadonlyMap<string, VerifiedTechEntry>,
): SourceSignal {
    const hit = map.get(normalizeAlias(name));
    if (hit) {
        return {
            ...signals,
            // A code-declared dependency matched in the SBOM (version + purl +
            // file:line) is the STRONGEST grounding available — mark it grounded
            // rather than leaving the model's guess.
            grounding:    'GROUNDED',
            verifiedTech: [{ name, version: hit.version, purl: hit.purl, path: hit.path, line: hit.line }],
        };
    }
    // No code-dependency match. If the item is otherwise evidenced (a commit,
    // PR, or changed file the agent cited), leave it — many legitimate stack
    // items aren't package dependencies. If it grounds to nothing, surface it.
    if (hasOtherEvidence(signals)) return signals;
    return {
        ...signals,
        grounding: signals.grounding === 'GROUNDED' ? signals.grounding : 'NOT_GROUNDED',
        ungroundedClaims: [...signals.ungroundedClaims, `stack item "${name}" not found in code dependencies`],
    };
}
