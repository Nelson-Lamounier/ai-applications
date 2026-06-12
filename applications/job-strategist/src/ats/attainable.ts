/**
 * @format
 * Attainable split — the honest pass-mark for the ATS feedback loop.
 *
 * The PASS BAR is VERIFIED-ONLY: the loop passes when every JD keyword the
 * candidate GENUINELY HAS (status `verified`) is present in the rendered resume.
 * `transferable` keywords are a BONUS — the candidate doesn't literally hold them
 * (e.g. OpenAI API via AWS Bedrock/Claude). They are still surfaced honestly via
 * their bridge and can earn ATS credit through the tech-transfer tier when the
 * resume names the real sibling, but they NEVER block the pass: requiring a
 * transferable keyword to appear literally would force a fabricated claim.
 *
 * GAP entries are excluded entirely — never surfaced, never counted.
 *
 * Two distinct outputs, do not conflate them:
 *   - `attainableMissing` (surfacing input): verified + transferable entries whose
 *     coverage row is present===false → fed to the one honest re-write so both get
 *     a fair, evidence-grounded surfacing attempt.
 *   - `attainablePassed` / `attainableTotal` / `attainableCovered` (the pass-mark):
 *     computed over VERIFIED JD keywords only.
 *
 * A tool's coverage row is found by bidirectional matchTier1 (the same lookup the
 * Skill Evidence Ledger uses). A verified entry with NO coverage row is not a JD
 * keyword for this role → it neither counts toward the total nor blocks the pass.
 *
 * Pure + deterministic. No LLM.
 */

import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from './keyword-match.js';

export interface AttainableSplit {
    /** Verified + transferable entries whose coverage row is present===false — the honest re-write input. */
    attainableMissing: SkillEvidenceEntry[];
    /** Count of VERIFIED entries that are JD keywords (have a coverage row). The pass universe. */
    attainableTotal: number;
    /** VERIFIED JD-keyword entries whose coverage row is present===true. */
    attainableCovered: number;
    /** True when no VERIFIED JD keyword is missing. Transferable keywords never block the pass. */
    attainablePassed: boolean;
}

/** An entry that may be surfaced — the candidate has it (verified) or can transfer it. */
function isSurfaceable(entry: SkillEvidenceEntry): boolean {
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

/** Per-entry classification against the coverage rows; null when the entry doesn't count. */
interface EntryClass {
    /** Verified JD keyword → counts toward the pass universe. */
    readonly counted: boolean;
    /** Verified JD keyword present in the resume. */
    readonly covered: boolean;
    /** Coverage row is present===false → surface (verified or transferable). */
    readonly missing: boolean;
    /** Verified JD keyword absent → the only thing that blocks the pass. */
    readonly verifiedMissing: boolean;
}

/** Classify one ledger entry. null = gap, or not a JD keyword for this role. */
function classifyEntry(
    e: SkillEvidenceEntry,
    coverage: ReadonlyArray<{ term: string; present: boolean }>,
): EntryClass | null {
    if (!isSurfaceable(e)) return null;           // gap → never surfaced, never counted
    const row = findCoverage(e.tool, coverage);
    if (!row) return null;                        // not a JD keyword for this role
    const verified = e.status === 'verified';
    return {
        counted: verified,
        covered: verified && row.present,
        missing: !row.present,
        verifiedMissing: verified && !row.present,
    };
}

/**
 * Split the ATS coverage against the Skill Evidence Ledger. The pass-mark is
 * verified-only; transferable entries are surfaced but never block the pass.
 * GAP tools are excluded entirely (honesty invariant).
 */
export function splitAttainable(
    coverage: ReadonlyArray<{ term: string; present: boolean }>,
    ledger: ReadonlyArray<SkillEvidenceEntry>,
): AttainableSplit {
    const attainableMissing: SkillEvidenceEntry[] = [];
    let attainableTotal = 0;
    let attainableCovered = 0;
    let verifiedMissing = 0;

    for (const e of ledger) {
        const c = classifyEntry(e, coverage);
        if (!c) continue;
        if (c.counted) attainableTotal += 1;
        if (c.covered) attainableCovered += 1;
        if (c.missing) attainableMissing.push(e);
        if (c.verifiedMissing) verifiedMissing += 1;
    }

    return {
        attainableMissing,
        attainableTotal,
        attainableCovered,
        attainablePassed: verifiedMissing === 0,
    };
}
