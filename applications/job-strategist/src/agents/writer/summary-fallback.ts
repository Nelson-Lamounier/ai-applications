/** @format */
/** Guard-safe minimal summary from the Fit Summary, used when the summary agent fails. */
export function deterministicSummary(fitSummary: string, targetRole: string): string {
    // Drop any sentence that names a gap/shortfall; keep the positive positioning.
    const kept = fitSummary.split(/(?<=[.!?])\s+/)
        .filter((s) => !/falls?\s+short|do(?:es)?\s*not\s+yet|lacks?\b|short of|missing\b/i.test(s));
    const base = kept.join(' ').trim();
    return base.length > 0 ? base : `${targetRole} with proven, evidence-backed delivery across the role's core responsibilities.`;
}
