/**
 * @format
 * Strategist Analysis Agent -- XML extraction helpers.
 *
 * MOVED verbatim from `agents/writer/strategist-agent.ts` (Phase 5 PR-B Task
 * 3): `extractMetadataFromXml`, `extractGapMitigations`, `extractTagArray`,
 * `extractTagValue`, `extractCdataValue`, and `extractArchetypeSelection`.
 * Bodies are byte-identical to their strategist-agent.ts originals -- only
 * the doc comments below were added. The originals stay in place in
 * strategist-agent.ts (marked with a relocation comment) until Task 8 deletes
 * the writer; both copies run the same logic until then.
 */
import type {
    StrategistAnalysisResult,
    RoleArchetypeSelection,
    ArchetypeId,
    GapMitigation,
} from '@bedrock/shared';
import { FitRatingSchema, ApplicationRecommendationSchema } from '../../schemas/dynamo-record.schema.js';

// =============================================================================
// XML METADATA EXTRACTION
// =============================================================================

/**
 * Extract key metadata fields from the XML analysis output.
 *
 * Uses simple regex extraction rather than a full XML parser to
 * avoid additional dependencies in the Lambda bundle.
 *
 * FitRating and ApplicationRecommendation values are Zod-validated
 * against their respective enum schemas. Invalid values fall back
 * to safe defaults via `.catch()`.
 *
 * @param xml - Raw XML analysis output
 * @returns Extracted metadata fields
 */
export function extractMetadataFromXml(xml: string): StrategistAnalysisResult['metadata'] {
    const extract = (tag: string): string => {
        const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
        const result = regex.exec(xml);
        return result?.[1]?.trim() ?? '';
    };

    return {
        candidateName: extract('candidate_name'),
        targetRole: extract('target_role'),
        targetCompany: extract('target_company'),
        analysisDate: extract('analysis_date'),
        overallFitRating: FitRatingSchema.catch('STRETCH').parse(extract('overall_fit_rating')),
        applicationRecommendation: ApplicationRecommendationSchema.catch('APPLY WITH CAVEATS').parse(extract('application_recommendation')),
    };
}

/**
 * Extract phase-3 gap mitigations into structured data. Field-by-field per
 * <mitigation> block (CDATA-tolerant, optional fields default to '') — the
 * defences were previously trapped in the raw XML while the UI rendered the
 * gap list without them.
 */
export function extractGapMitigations(xml: string): GapMitigation[] {
    const out: GapMitigation[] = [];
    const tag = (block: string, name: string): string => {
        const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(block);
        return m ? m[1].trim() : '';
    };
    const blockRe = /<mitigation>([\s\S]*?)<\/mitigation>/g;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(xml)) !== null) {
        const gap = tag(match[1], 'gap');
        const honestFraming = tag(match[1], 'honest_framing');
        if (!gap || !honestFraming) continue;
        out.push({
            gap,
            honestFraming,
            bridgeNarrative: tag(match[1], 'bridge_narrative'),
            proactiveAction: tag(match[1], 'proactive_action'),
            goNoGo: tag(match[1], 'go_no_go') || 'conditional',
        });
    }
    return out;
}

// =============================================================================
// PHASE 0 ARCHETYPE EXTRACTION
// =============================================================================

/**
 * Pull inner tag values out of a parent content block.
 *
 * Uses String.matchAll — avoids exec() to prevent false-positive
 * security hook triggers on RegExp.prototype.exec() patterns.
 */
function extractTagArray(content: string, tag: string): string[] {
    const pattern = new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs');
    return Array.from(content.matchAll(pattern)).map((m) => m[1].trim());
}

/** Extract a single plain-text tag value from a content block. */
function extractTagValue(content: string, tag: string): string {
    const pattern = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
    return content.match(pattern)?.[1]?.trim() ?? '';
}

/** Extract a CDATA-wrapped tag value (falls back to plain-text tag). */
function extractCdataValue(content: string, tag: string): string {
    const cdataPattern = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`);
    const raw = content.match(cdataPattern)?.[1]?.trim();
    return raw ?? extractTagValue(content, tag);
}

/**
 * Extract the Phase 0 archetype selection from the XML analysis.
 *
 * Parses the `<phase_0_archetype_selection>` section introduced in the
 * Option A architecture. Returns null when the section is absent (legacy
 * runs or Strategist output that predates Phase 0).
 *
 * @param xml - Raw XML analysis output
 * @returns Parsed archetype selection, or null
 */
export function extractArchetypeSelection(xml: string): RoleArchetypeSelection | null {
    const sectionPattern = /<phase_0_archetype_selection>([\s\S]*?)<\/phase_0_archetype_selection>/;
    const sectionMatch = xml.match(sectionPattern);
    if (!sectionMatch) return null;

    const content = sectionMatch[1];

    const triggerBlock = content.match(/<trigger_phrases_matched>([\s\S]*?)<\/trigger_phrases_matched>/)?.[1] ?? '';
    const excludedBlock = content.match(/<excluded_content_categories>([\s\S]*?)<\/excluded_content_categories>/)?.[1] ?? '';

    const archetypeIdRaw = parseInt(extractTagValue(content, 'archetype_id'), 10);
    const archetypeId: ArchetypeId = ([1, 2, 3, 4, 5, 6, 7].includes(archetypeIdRaw)
        ? archetypeIdRaw
        : 1) as ArchetypeId;

    const confidenceRaw = parseFloat(extractTagValue(content, 'confidence_score'));
    const confidenceScore = isNaN(confidenceRaw) ? 0.5 : Math.min(1, Math.max(0, confidenceRaw));

    return {
        selectedArchetype: extractTagValue(content, 'selected_archetype'),
        archetypeId,
        triggerPhrasesMatched: extractTagArray(triggerBlock, 'phrase'),
        excludedContentCategories: extractTagArray(excludedBlock, 'category'),
        leadIdentity: extractCdataValue(content, 'lead_identity'),
        confidenceScore,
        archetypeGapDetected: extractTagValue(content, 'archetype_gap_detected') === 'true',
    };
}
