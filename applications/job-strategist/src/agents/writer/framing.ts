/**
 * @format
 * Years-gap framing directive.
 *
 * Relocated from strategist-agent.ts ahead of the writer's deletion (Phase 5
 * PR-B) -- this function is a load-bearing survivor consumed by
 * run-pipeline.ts.
 */

/**
 * Tenure framing is conditional: with no years bar in the JD the framing may
 * shape the SUMMARY only — the cover letter must not mention tenure at all.
 */
export function framingDirective(yearsGap: { framingLine: string; requiredYears: number | null } | null | undefined): string | undefined {
    if (!yearsGap) return undefined;
    if (yearsGap.requiredYears == null) {
        return `${yearsGap.framingLine} [NO YEARS BAR IN THIS JD: summary only — the cover letter must NOT mention years or tenure]`;
    }
    return yearsGap.framingLine;
}
