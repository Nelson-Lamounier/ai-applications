/**
 * @format
 * Analysis-agent per-phase eval - offline structural graders.
 *
 * Grades `StrategistAnalysisResult` (the exact type `executeAnalysisAgent`
 * returns via `parseAnalysisResponse`) against a fixed research-gaps list. No
 * Bedrock call - pure, deterministic checks against a fixed AnalysisEvalInput.
 */
import type { StrategistAnalysisResult, FitRating, ArchetypeId } from '@bedrock/shared';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact result the analysis phase produces + the research-gap context it was graded against. */
export interface AnalysisEvalInput {
    readonly result: StrategistAnalysisResult;
    /** Research Agent's `gaps[].skill` list -- the ONLY skills a gap mitigation may legitimately name. */
    readonly researchGaps: readonly string[];
}

const VALID_ARCHETYPE_IDS: ReadonlySet<ArchetypeId> = new Set([1, 2, 3, 4, 5, 6, 7]);

/**
 * Phase 0 archetype selection must be present and well-formed: archetypeId is
 * an integer in 1-7, selectedArchetype and leadIdentity are non-empty.
 */
export function archetypeValidGrader(i: AnalysisEvalInput): GraderResult {
    const failures: string[] = [];
    const sel = i.result.archetypeSelection;
    if (!sel) {
        failures.push('archetypeSelection is null -- Phase 0 must emit an explicit selection');
        return mkResult('archetypeValid', failures);
    }
    if (!Number.isInteger(sel.archetypeId) || !VALID_ARCHETYPE_IDS.has(sel.archetypeId)) {
        failures.push(`archetypeId ${sel.archetypeId} is not an integer in 1-7`);
    }
    if (!sel.selectedArchetype.trim()) failures.push('selectedArchetype is empty');
    if (!sel.leadIdentity.trim()) failures.push('leadIdentity is empty');
    return mkResult('archetypeValid', failures);
}

/**
 * No fabricated gap mitigations: every `gapMitigations[].gap` must name a
 * skill present in the research brief's gaps list (case-insensitive, exact).
 * Vacuous when there are no mitigations to check.
 */
export function noGapFabricationGrader(i: AnalysisEvalInput): GraderResult {
    const allowed = new Set(i.researchGaps.map((g) => g.trim().toLowerCase()));
    const failures: string[] = [];
    for (const m of i.result.gapMitigations) {
        if (!allowed.has(m.gap.trim().toLowerCase())) {
            failures.push(`fabricated gap mitigation "${m.gap}" -- not present in the research gaps list`);
        }
    }
    return mkResult('noGapFabrication', failures);
}

const VALID_FIT_RATINGS: ReadonlySet<FitRating> = new Set(['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH']);

/** overallFitRating must be one of the four FitRating enum values. */
export function fitRatingGrader(i: AnalysisEvalInput): GraderResult {
    const rating = i.result.metadata.overallFitRating;
    const failures = VALID_FIT_RATINGS.has(rating) ? [] : [`overallFitRating "${rating}" is not a valid FitRating`];
    return mkResult('fitRating', failures);
}

/** All structural graders, in display order. */
export const ANALYSIS_GRADERS = [archetypeValidGrader, noGapFabricationGrader, fitRatingGrader] as const;

/** Run every grader; overall pass = all pass. */
export function runAnalysisGraders(i: AnalysisEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = ANALYSIS_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
