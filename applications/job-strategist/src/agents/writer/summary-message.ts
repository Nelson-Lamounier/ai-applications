/**
 * @format
 * Focused user-message builder for the dedicated summary agent.
 *
 * The summary agent emits four beats (S1-S4) and needs only a narrow slice of
 * what the full Strategist writer sees: the Fit Summary as the source of
 * truth for positioning, the finished resume body (for altitude checks -
 * never restate a number already in a bullet), the verified/partial/gap
 * verdicts (never claim a gap), the resume-domain constraints (mandatory
 * rules and gap boundaries the summary must respect), the company problem
 * (S2 bridge), profile intelligence (S3 distinctive angle), years-gap
 * framing (S1), and achievement evidence (S3/S4 alternative material).
 */
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';

/** Everything the summary-agent message builder may read. */
export interface SummaryMessageInput {
    readonly research: StrategistResearchResult;
    /** Finished resume body (summary field ignored - this agent produces it). */
    readonly body: StructuredResumeData;
    readonly profileIntelligence: string;
    readonly yearsGapFraming: string;
    readonly achievementEvidence: string;
    /** Optional JD must-haves the summary should try to surface naturally (subordinate to the fit thesis). */
    readonly atsTargets?: readonly string[];
    /** Optional re-write pass: the previous draft to weave missing targets into. */
    readonly rewriteDraft?: string;
    /** Optional re-write pass: the ATS targets the previous draft missed. */
    readonly rewriteMissing?: readonly string[];
}

/** ATS-targets + re-write-pass blocks -- split out of buildSummaryMessage to keep
 *  its complexity down; both blocks are optional and independent of each other. */
function buildAtsBlocks(m: SummaryMessageInput): string[] {
    const out: string[] = [];
    const atsTargets = m.atsTargets ?? [];
    if (atsTargets.length > 0) {
        out.push(
            '',
            '## ATS Targets (subordinate to the fit thesis - surface naturally, never fabricate)',
            'These JD must-haves are attainable and high-value. Surface them by name where a beat NATURALLY supports it, using the candidate evidence above. If a target has no honest home, OMIT it - never break the fit thesis, the word cap, the no-gap rule, or the altitude rule to fit one.',
            ...atsTargets.map((t) => `- ${t}`),
        );
    }

    if (m.rewriteDraft && (m.rewriteMissing?.length ?? 0) > 0) {
        out.push(
            '',
            '## Re-write pass (keep the narrative; weave the missing targets only if honestly supported)',
            'Below is your previous draft. Preserve its fit-thesis narrative and altitude. Weave in the missing ATS targets ONLY where the candidate evidence honestly supports it -- do not fabricate, do not exceed the word cap, do not name gaps. If a missing target has no honest home, leave it out.',
            'Previous draft:',
            m.rewriteDraft,
            'Missing targets to weave if honestly supported:',
            ...(m.rewriteMissing ?? []).map((t) => `- ${t}`),
        );
    }
    return out;
}

/** Focused user message for the summary agent - only what S1-S4 need. */
export function buildSummaryMessage(m: SummaryMessageInput): string {
    const { research, body } = m;
    const out: string[] = [
        '## Fit Summary (SOURCE OF TRUTH - translate this into positive positioning)',
        research.fitSummary,
        `Overall fit rating: ${research.overallFitRating}`,
        '',
        '## Finished resume body (positioning must match; do NOT reuse any number below)',
        '### Experience',
        ...body.experience.flatMap((e) => [
            `- ${e.title} @ ${e.company} (${e.period})`,
            ...(e.highlights ?? []).map((h) => `  - ${h}`),
        ]),
        '### Projects',
        ...body.projects.flatMap((p) => [`- ${p.name}`, ...(p.highlights ?? []).map((h) => `  - ${h}`)]),
        '',
        '## Verified strengths (may lead)',
        ...research.verifiedMatches.map((v) => `- ${v.skill}`),
        '## Partial (frame as transferable, never owned)',
        ...research.partialMatches.map((p) => `- ${p.skill}`),
        '## Gaps (NEVER claim these)',
        ...research.gaps.map((g) => `- ${g.skill}`),
    ];

    if (research.resumeConstraints?.trim()) {
        out.push(
            '',
            '## Resume Domain Constraints (MANDATORY - apply BEFORE and AFTER composing each beat)',
            'Non-negotiable rules and gap boundaries from the resume domain KB. Never state an ABSENT skill, never cross a boundary these set, even if the fit thesis or evidence seems to invite it.',
            research.resumeConstraints.trim(),
        );
    }

    if (research.companyProblem?.trim()) {
        out.push(
            '',
            '## The problem this role solves (S2 bridge - candidate voice, never name the company)',
            research.companyProblem.trim(),
        );
    }

    if (m.profileIntelligence.trim()) {
        out.push('', '## Profile Intelligence (S3 distinctive angle - undersold, code-proven strengths)', m.profileIntelligence.trim());
    }

    if (m.yearsGapFraming.trim()) {
        out.push('', `## Years framing (S1): ${m.yearsGapFraming.trim()}`);
    }

    if (m.achievementEvidence.trim()) {
        out.push('', '## Achievement evidence (S3/S4 alternative)', m.achievementEvidence.trim());
    }

    out.push(...buildAtsBlocks(m), '', 'Emit the four beats via the tool. 100 words total across s1-s4.');
    return out.join('\n');
}
