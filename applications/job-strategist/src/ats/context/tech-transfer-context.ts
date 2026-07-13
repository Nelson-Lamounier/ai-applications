/**
 * @format
 * Tech Transfer Context Builder — A5 helper
 *
 * Builds a short LLM-readable context string from the JD tools' transfer groups.
 * For each JD tech tool that belongs to a tech group, emits one line per group
 * listing all members as interchangeable skills.
 *
 * Pure function — no I/O. Returns '' when no groups intersect.
 */

import { normalizeTerm } from '../matching/keyword-match.js';

/**
 * Resolve a raw term to its canonical form via alias map, then normalize.
 * Alias map keys are lowercased.
 */
function resolveCanonical(term: string, aliasMap: Map<string, string>): string {
    const termLower = term.toLowerCase().trim();
    return aliasMap.get(termLower) ?? normalizeTerm(term).replace(/ /g, '_');
}

/**
 * Format a single tech group as a readable "interchangeable" line.
 * Members are title-cased for readability (underscores → spaces).
 */
function formatGroupLine(members: string[]): string {
    const display = members.map((m) => m.replace(/_/g, ' '));
    return `- Interchangeable LLM-platform skills: ${display.join(', ')} — verified work with any one is transferable to the others.`;
}

/**
 * Build a short context block for the LLM matcher listing the tech transfer groups
 * that are relevant to the current JD (i.e. at least one JD tool is in the group).
 *
 * Only groups that intersect the JD tool list are included — the full ontology is
 * never dumped into the prompt.
 *
 * @param jdTools   - Raw JD tool/language/skill strings from the extraction
 * @param techGroups - Transfer groups: arrays of lowercased canonical tech names
 * @param aliasMap  - Alias → canonical map (lowercased keys)
 * @returns Formatted context string, or '' when no groups intersect
 */
export function formatTechTransferContext(
    jdTools: string[],
    techGroups: string[][],
    aliasMap: Map<string, string>,
): string {
    if (jdTools.length === 0 || techGroups.length === 0) return '';

    // Resolve each JD tool to its canonical form
    const jdCanonicals = new Set(jdTools.map((t) => resolveCanonical(t, aliasMap)));

    // Collect groups that intersect at least one JD canonical (dedupe by reference equality)
    const emittedGroups = new Set<string[]>();
    for (const group of techGroups) {
        if (group.some((member) => jdCanonicals.has(member))) {
            emittedGroups.add(group);
        }
    }

    if (emittedGroups.size === 0) return '';

    const lines: string[] = [];
    for (const group of emittedGroups) {
        lines.push(formatGroupLine(group));
    }

    return [
        '## Technology Transferability (grounded — credit transferable evidence accordingly)',
        ...lines,
    ].join('\n');
}
