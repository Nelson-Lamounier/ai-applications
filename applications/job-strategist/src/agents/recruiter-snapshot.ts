/** @format */
import { z } from 'zod';
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { StrategistResearchResult } from '@bedrock/shared';

export const RecruiterRedFlagSchema = z.object({
    flag: z.string(),
    why:  z.string(),
});

export const RecruiterSnapshotSchema = z.object({
    score:           z.number().int().min(0).max(100),
    scoreRationale:  z.string(),
    missingKeywords: z.array(z.string()).max(5),
    redFlags:        z.array(RecruiterRedFlagSchema).max(3),
});

export type RecruiterSnapshot = z.infer<typeof RecruiterSnapshotSchema>;

/** Weights for the deterministic baseline (sum to 1). Tunable in one place. */
const W_COVERAGE = 0.5;
const W_VERIFIED = 0.3;
const W_HARDREQ  = 0.2;

// Weights must sum to 1 or the score can leave [0,100].
if (W_COVERAGE + W_VERIFIED + W_HARDREQ !== 1) {
    throw new Error('recruiter-snapshot: baseline score weights must sum to 1');
}

/**
 * Deterministic 0–100 baseline from real signals: ATS keyword coverage, the
 * verified-vs-gap ratio, and how many hard requirements are evidenced.
 */
export function computeBaselineScore(
    research: Pick<StrategistResearchResult, 'verifiedMatches' | 'gaps' | 'hardRequirements'>,
    atsCheck: AtsCheckResult,
): number {
    const cov = atsCheck.jdKeywordCoverage;
    const keywordCoverage = cov.length === 0 ? 0 : cov.filter((k) => k.present).length / cov.length;

    const v = research.verifiedMatches.length;
    const g = research.gaps.length;
    const verifiedRatio = v + g === 0 ? 0 : v / (v + g);

    const hardReqs = research.hardRequirements;
    const verifiedSkills = new Set(research.verifiedMatches.map((m) => m.skill.toLowerCase()));
    const hardReqHit = hardReqs.length === 0
        ? 1
        : hardReqs.filter((r) => verifiedSkills.has(r.skill.toLowerCase())).length / hardReqs.length;

    return Math.round(100 * (W_COVERAGE * keywordCoverage + W_VERIFIED * verifiedRatio + W_HARDREQ * hardReqHit));
}
