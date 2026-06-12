/**
 * @format
 * Attainable split — the honest pass-mark for the ATS feedback loop.
 *
 * "Attainable" = ledger entries the candidate genuinely HAS (verified) or can
 * honestly transfer (transferable). GAP entries are excluded — they must never
 * be surfaced, so they can never count toward the pass-mark.
 *
 * For each attainable entry we locate its ATS coverage row by matching the
 * entry's tool to a coverage term (bidirectional matchTier1, the same lookup
 * the Skill Evidence Ledger uses). If the row exists and `present === false`,
 * the candidate has the skill but the rendered resume + every ATS tier missed
 * it — that's an `attainableMissing` row, the input to the one honest re-write.
 *
 * Pure + deterministic. No LLM.
 */

import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from './keyword-match.js';

export interface AttainableSplit {
    /** Attainable entries whose coverage row exists and is present===false. */
    attainableMissing: SkillEvidenceEntry[];
    /** Count of attainable entries (verified + transferable). */
    attainableTotal: number;
    /** Attainable entries whose coverage row is present===true. */
    attainableCovered: number;
    /** True when nothing attainable is missing. */
    attainablePassed: boolean;
}

/** An attainable entry is one the candidate has (verified) or can transfer. */
function isAttainable(entry: SkillEvidenceEntry): boolean {
    return entry.status === 'verified' || entry.status === 'transferable';
}

/**
 * Find the coverage row matching this tool by bidirectional matchTier1 lookup
 * (case-insensitive; "Python" finds "Python scripting" via either direction).
 */
function findCoverage(
    tool: string,
    coverage: ReadonlyArray<{ term: string; present: boolean }>,
): { term: string; present: boolean } | undefined {
    return coverage.find((c) => matchTier1(tool, c.term) || matchTier1(c.term, tool));
}

/**
 * Split the ATS coverage against the Skill Evidence Ledger into the attainable
 * pass-mark. GAP tools are never attainable (honesty invariant).
 */
export function splitAttainable(
    coverage: ReadonlyArray<{ term: string; present: boolean }>,
    ledger: ReadonlyArray<SkillEvidenceEntry>,
): AttainableSplit {
    const attainable = ledger.filter(isAttainable);
    const attainableMissing: SkillEvidenceEntry[] = [];
    let attainableCovered = 0;

    for (const entry of attainable) {
        const row = findCoverage(entry.tool, coverage);
        if (!row) continue; // no coverage term for this tool — neither covered nor missing
        if (row.present) {
            attainableCovered += 1;
        } else {
            attainableMissing.push(entry);
        }
    }

    return {
        attainableMissing,
        attainableTotal: attainable.length,
        attainableCovered,
        attainablePassed: attainableMissing.length === 0,
    };
}
