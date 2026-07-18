/**
 * @format
 * doc-type-classifier — assign a semantic doc type to a `docs`-lane file
 *
 * `classifyFile` (file-classifier.ts) already tells retrieval "this chunk is
 * documentation" via `fileClass === 'docs'`. That is too coarse to answer
 * "find the ADRs" or "find the runbooks" as a categorical filter — every
 * markdown file collapses into the same bucket. This module refines the
 * `docs` lane into a closed taxonomy stamped once per file at the same
 * ChunkerRegistry choke point.
 *
 * Pure and deterministic. Three tiers, first match wins:
 *   1. Filename (basename, case-insensitive) — README/CHANGELOG/CONTRIBUTING
 *      are unambiguous regardless of where they live.
 *   2. Path segment (any position) — directory conventions (`decisions/`,
 *      `runbooks/`, `specs/`, …) are a stronger, cheaper signal than content
 *      and cost nothing to check.
 *   3. Content sniff — ONLY reached when tiers 1-2 both miss. Deliberately
 *      narrow (two shapes, each requiring two independent signals) to keep
 *      the false-positive rate near zero; every sniff has a near-miss test.
 *   4. Fallback — `doc`.
 */

export const DOC_TYPES = [
    'readme', 'adr', 'runbook', 'troubleshooting', 'concept',
    'guide', 'spec', 'changelog', 'contributing', 'doc',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

function baseName(filePath: string): string {
    return filePath.split('/').pop() ?? '';
}

/** True when `path` has `segment` as a full path component, anywhere. */
function hasPathSegment(path: string, segment: string): boolean {
    return new RegExp(`(^|/)${segment}(/|$)`, 'i').test(path);
}

const FILENAME_RULES: ReadonlyArray<readonly [RegExp, DocType]> = [
    [/^readme/i, 'readme'],
    [/^changelog/i, 'changelog'],
    [/^contributing/i, 'contributing'],
];

const PATH_SEGMENT_RULES: ReadonlyArray<readonly [readonly string[], DocType]> = [
    [['decisions', 'adr', 'adrs'], 'adr'],
    [['runbooks'], 'runbook'],
    [['troubleshooting'], 'troubleshooting'],
    [['concepts', 'patterns'], 'concept'],
    [['guides', 'tutorials'], 'guide'],
    [['specs', 'plans', 'rfcs'], 'spec'],
];

/** Numbered filename prefix, e.g. `0001-use-postgres.md` (MADR/ADR convention). */
const NUMBERED_PREFIX = /^\d{4}-/;

/** `## Status`, `## Decision`, or a `Status:` line — MADR/ADR shape. */
const ADR_HEADING = /^#{1,6}\s*(status|decision)\b/im;
const ADR_STATUS_LINE = /^status:\s*\S/im;

/** `## Symptom` or `## Diagnose` — the runbook problem-statement heading. */
const RUNBOOK_PROBLEM_HEADING = /^#{1,6}\s*(symptom|diagnose)\b/im;
/** `## Fix` or `## Verify` — the runbook resolution heading. */
const RUNBOOK_RESOLUTION_HEADING = /^#{1,6}\s*(fix|verify)\b/im;

function sniffAdr(filePath: string, headContent: string): boolean {
    if (!NUMBERED_PREFIX.test(baseName(filePath))) return false;
    return ADR_HEADING.test(headContent) || ADR_STATUS_LINE.test(headContent);
}

function sniffRunbook(headContent: string): boolean {
    return RUNBOOK_PROBLEM_HEADING.test(headContent) && RUNBOOK_RESOLUTION_HEADING.test(headContent);
}

/**
 * Assign a single doc type to a `docs`-lane file. First matching tier wins;
 * the content sniff only runs when both path tiers miss.
 */
export function classifyDocType(filePath: string, headContent: string): DocType {
    const base = baseName(filePath);
    for (const [pattern, docType] of FILENAME_RULES) {
        if (pattern.test(base)) return docType;
    }

    for (const [segments, docType] of PATH_SEGMENT_RULES) {
        if (segments.some((segment) => hasPathSegment(filePath, segment))) return docType;
    }

    if (sniffAdr(filePath, headContent)) return 'adr';
    if (sniffRunbook(headContent)) return 'runbook';

    return 'doc';
}
