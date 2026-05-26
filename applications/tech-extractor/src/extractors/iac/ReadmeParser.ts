/** @format */
import type { RawTechnologyEvidence } from '../Extractor.js';

/** Pull the subject of shields.io badges (`/badge/<subject>-<status>-<color>`). */
export function parseReadme(src: string, filePath: string): RawTechnologyEvidence[] {
    const out: RawTechnologyEvidence[] = [];
    const re = /img\.shields\.io\/badge\/([^-/)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const subject = decodeURIComponent(m[1]).trim();
        if (subject) out.push({ raw_name: subject, ecosystem: 'readme', source_layer: 'readme', file_path: filePath });
    }
    return out;
}

// ============================================================================
// ReadmeParser v2 — prose extraction
// ============================================================================
//
// Closes the "LLM-only canonicals from prose mentions" gap surfaced in the
// 2026-05-26 parity analysis. The LLM enricher's residual advantage was
// catching tech names in free-form English (READMEs, doc files, code
// comments) — places no import-scanner or manifest-parser reaches.
//
// Design constraint: substring-matching aliases against arbitrary English
// produces false positives ("go" matches every sentence using the verb;
// "react" matches every sentence with the verb; "rust" matches metaphors).
// The ontology's strength — broad alias coverage — becomes a weakness in
// unstructured prose.
//
// Four mitigations agreed in the 2026-05-26 design review:
//
//   1. (this PR)  prose_safe filter — caller passes ONLY aliases tagged
//        prose_safe=true (technology_aliases.prose_safe column,
//        bootstrapped via the Bedrock Converse tagger in ProseSafeTagger.ts).
//        Done at the boundary: this parser doesn't know about prose_safe,
//        it just consumes a Set<string> of safe-to-match alias strings.
//   2. (this PR)  length floor — opts.minAliasLength (default 4). Rejects
//        2-3-char aliases even if somehow tagged prose_safe.
//   3. (v2.1)     context-window scoring — boost confidence when a
//        category-related word ("dashboard"/"metrics"/"observability"/...)
//        appears within N tokens of the match.
//   4. (v2.2)     negation detection — within a sentence window, suppress
//        matches whose surrounding context contains "not using"/"rejected"/
//        "considered but"/"instead of"/etc.
//
// Wiring (loadProseSafeAliases repo method + orchestrator integration) is
// the next PR after this one.

export interface ProseParserOpts {
    /** Minimum alias length; aliases shorter than this are silently skipped.
     *  Default 4: kills 2-3-char abbreviations (`go`, `ts`, `sh`, `pg`, `s3`,
     *  `ec2`) even if they somehow ended up in the prose-safe set. */
    minAliasLength?: number;
    /** Max number of distinct (alias x line) emissions per file; prevents a
     *  pathological README (e.g. one that lists 500 packages) from flooding
     *  the evidence table. Default 200. */
    maxEmissions?: number;
}

/**
 * One prose range to scan. `text` is a single line's content; `line_start` is
 * the absolute line number to attribute matches to (so callers like the
 * code-comment extractor can feed already-extracted comment ranges with their
 * original source-file line numbers preserved).
 */
export interface ProseLineInput {
    readonly text: string;
    readonly line_start: number;
}

/**
 * Pure: scan arbitrary prose ranges for case-insensitive word-boundary
 * mentions of any alias in the supplied set. Emits one RawTechnologyEvidence
 * per (alias x line_start) — same alias on the same range emits once; same
 * alias on a different range emits again so the downstream code can use
 * multi-line hits as a confidence signal.
 *
 * Used by both {@link parseReadmeProse} (whole-file line split) and the
 * code-comment extractor (pre-extracted comment ranges that retain their
 * original line numbers).
 *
 * @param ranges    Iterable of `{ text, line_start }` rows.
 * @param filePath  Path of the file (for evidence provenance).
 * @param aliasSet  Lower-cased prose-safe aliases. Caller MUST pre-filter to
 *                  prose_safe=true rows (mitigation 1) and lowercase entries.
 * @param opts      length floor + emission cap.
 */
export function scanProseRanges(
    ranges: Iterable<ProseLineInput>,
    filePath: string,
    aliasSet: ReadonlySet<string>,
    opts: ProseParserOpts = {},
): RawTechnologyEvidence[] {
    const minLen = opts.minAliasLength ?? 4;
    const maxEmissions = opts.maxEmissions ?? 200;
    if (aliasSet.size === 0) return [];

    const out: RawTechnologyEvidence[] = [];
    const seen = new Set<string>(); // dedupe key: `${alias}@${line_start}`

    for (const r of ranges) {
        if (!r.text) continue;

        // Tokenize on non-alphanumeric boundaries, but keep `-`, `_`, `.`, `/`,
        // `@` so multi-part aliases like `@aws-sdk/client-s3`, `next-auth`,
        // `aws_lambda`, `node.js`, `pg/pg-pool` can match as single tokens.
        // Lowercase for case-insensitive match against the alias set.
        const tokens = r.text.toLowerCase().match(/[a-z0-9_@./-]+/g) ?? [];
        for (const raw of tokens) {
            // Trim trailing punctuation only (sentence-end `.`, list `,`-stripped
            // upstream, path-style `/-_`). Keep LEADING `@` for npm scoped
            // packages (`@aws-sdk/...`); keep inner separators verbatim.
            const tok = raw.replace(/[._/-]+$/g, '');
            if (tok.length < minLen) continue;
            if (!aliasSet.has(tok)) continue;
            const key = `${tok}@${r.line_start}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                raw_name:    tok,
                ecosystem:   'readme',
                source_layer:'readme',
                file_path:   filePath,
                line_start:  r.line_start,
                line_end:    r.line_start,
            });
            if (out.length >= maxEmissions) return out;
        }
    }
    return out;
}

/**
 * Pure: scan README/doc prose for case-insensitive word-boundary mentions of
 * any alias in the supplied set. Shim over {@link scanProseRanges}: splits
 * `src` on `\n` and feeds each line as a range with `line_start = i + 1`.
 *
 * @param src       README content (markdown, plain text, anything).
 * @param filePath  Path of the file (for evidence provenance).
 * @param aliasSet  Lower-cased prose-safe aliases. Caller MUST pre-filter to
 *                  prose_safe=true rows (mitigation 1) and lowercase entries.
 * @param opts      length floor + emission cap.
 */
export function parseReadmeProse(
    src: string,
    filePath: string,
    aliasSet: ReadonlySet<string>,
    opts: ProseParserOpts = {},
): RawTechnologyEvidence[] {
    const ranges: ProseLineInput[] = src.split('\n').map((text, i) => ({ text, line_start: i + 1 }));
    return scanProseRanges(ranges, filePath, aliasSet, opts);
}
