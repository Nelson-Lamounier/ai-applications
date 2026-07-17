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

import type { TechTransferGroup } from '@bedrock/shared';
import { resolveCanonical } from '../matching/keyword-match.js';

/**
 * Format a single tech group as a readable "interchangeable" line, plus an
 * optional PARTIAL-tier warning line. Members are title-cased for readability
 * (underscores → spaces). When `transferBasis` is present, appends
 * `(full transfer: <basis>)` or `(partial transfer: <basis>)` to the group
 * line depending on tier; for `partial` tier ALSO appends a follow-up line
 * (after the basis suffix) warning never to claim direct experience.
 * Groups with null metadata (no typed edges) render exactly as before.
 */
function formatGroupLine(group: TechTransferGroup): string {
    const display = group.members.map((m) => m.replaceAll('_', ' '));
    const basisSuffix = group.transferBasis && group.transferTier
        ? ` (${group.transferTier} transfer: ${group.transferBasis})`
        : '';
    const line = `- Interchangeable LLM-platform skills: ${display.join(', ')} — verified work with any one is transferable to the others.${basisSuffix}`;
    if (group.transferTier === 'partial') {
        return `${line}\n  Treat as PARTIAL evidence only - never claim direct experience.`;
    }
    return line;
}

/**
 * Build a short context block for the LLM matcher listing the tech transfer groups
 * that are relevant to the current JD (i.e. at least one JD tool is in the group).
 *
 * Only groups that intersect the JD tool list are included — the full ontology is
 * never dumped into the prompt.
 *
 * Since `TechnologyOntologyRepository.loadTransferGroups()` derives TYPED groups
 * (`transferClass` non-null) from typed edges only and UNTYPED groups from the
 * remaining graph connectivity, a canonical can legitimately appear in both a
 * typed group and an untyped component (e.g. `aws_bedrock` in the typed
 * `ai-provider` class AND an untyped `aws`-rooted component via a structural
 * `part_of` edge). Rendering both would echo the same JD skill twice with
 * different (or missing) transfer framing. The rule applied here: TYPED groups
 * take precedence — every untyped component is skipped when every JD canonical
 * it matches is already covered by an emitted typed group (a pure echo); an
 * untyped component surfacing a JD canonical no typed group covers is still
 * emitted, since it carries information the typed groups don't.
 *
 * @param jdTools   - Raw JD tool/language/skill strings from the extraction
 * @param techGroups - Transfer groups (each carries lowercased canonical `.members`)
 * @param aliasMap  - Alias → canonical map (lowercased keys)
 * @returns Formatted context string, or '' when no groups intersect
 */
export function formatTechTransferContext(
    jdTools: string[],
    techGroups: TechTransferGroup[],
    aliasMap: Map<string, string>,
): string {
    if (jdTools.length === 0 || techGroups.length === 0) return '';

    // Resolve each JD tool to its canonical form
    const jdCanonicals = new Set(jdTools.map((t) => resolveCanonical(t, aliasMap)));

    const typedGroups = techGroups.filter((g) => g.transferClass !== null);
    const untypedGroups = techGroups.filter((g) => g.transferClass === null);

    // Typed groups take precedence: emit every typed group intersecting the JD,
    // and record which JD canonicals they cover.
    const emittedGroups: TechTransferGroup[] = [];
    const typedCoveredCanonicals = new Set<string>();
    for (const group of typedGroups) {
        const hits = group.members.filter((member) => jdCanonicals.has(member));
        if (hits.length === 0) continue;
        emittedGroups.push(group);
        for (const hit of hits) typedCoveredCanonicals.add(hit);
    }

    // Untyped components: skip when every JD canonical they match is already
    // covered by an emitted typed group (a redundant echo of the same skill);
    // still emit when they surface a JD canonical no typed group covered.
    for (const group of untypedGroups) {
        const hits = group.members.filter((member) => jdCanonicals.has(member));
        if (hits.length === 0) continue;
        if (hits.every((hit) => typedCoveredCanonicals.has(hit))) continue;
        emittedGroups.push(group);
    }

    if (emittedGroups.length === 0) return '';

    const lines = emittedGroups.map(formatGroupLine);

    return [
        '## Technology Transferability (grounded — credit transferable evidence accordingly)',
        ...lines,
    ].join('\n');
}
