/** @format */
/**
 * Assembles VERBATIM grounding-facts blocks into a single text blob used to
 * seed the number-provenance allowed set (see `number-provenance.ts`).
 *
 * Every part passed in must trace to verbatim evidence — verified career
 * facts (`formatExperienceFacts`), documented project evidence
 * (`projectEvidenceBlock`), KB-verbatim quantified metrics
 * (`groundedMetricsBlock` = `composeMetricsBlock(metricsLedgerBlock,
 * researchData.quantifiedEvidence)`), or server-computed values
 * (`formatVerifiedYearsFact`).
 *
 * The matcher's free-text `sourceCitation` prose
 * (`researchData.verifiedMatches[].sourceCitation`) is a PARAPHRASE of where a
 * skill is demonstrated, not verbatim KB text — it must never be one of these
 * parts. Folding it in let a paraphrased number (e.g. "cut deploy time 40%")
 * launder itself into the allowed set and surface in a resume bullet as if it
 * were verified evidence (F2).
 */
export function buildGroundingFacts(parts: readonly string[]): string {
    return parts.filter(Boolean).join('\n\n');
}
