/**
 * @format
 * Coach grounding adapters — pure helpers that turn the coach's inputs and output
 * into a (contextChunks, answer) pair for BedrockGroundingVerifier.
 *
 * This is the *text-level* grounding layer for coach output. It complements the
 * deterministic *citation-level* guard already applied in executeCoachAgent
 * (validateSkillTransfer demotes invented skillTransfer refs to gaps). Here we
 * verify the free-text *experiential* claims — career arc, JD talking points,
 * STAR/answer frameworks, skill-transfer narratives — against the sources the
 * coach was told to ground in (the Strategist analysis + verified-evidence digest
 * + stage-prep constraints + candidate block).
 *
 * Runs in 'flag' mode only: the coach output is structured JSON, so block-mode
 * fallback substitution (a one-line string) would corrupt it. Flag surfaces an
 * ungrounded verdict via telemetry without altering what is persisted.
 */
import type { InterviewCoachResult } from '@bedrock/shared';

export interface CoachGroundingSources {
    readonly analysisXml: string;
    readonly evidenceBlock?: string;
    readonly constraintBlock?: string;
    readonly skillCandidateBlock?: string;
}

/**
 * The source passages the coach is permitted to ground in. Each non-empty block
 * becomes its own chunk so the verifier prompt can cite them as [1], [2], ….
 */
export function buildCoachContextChunks(sources: CoachGroundingSources): string[] {
    return [
        sources.analysisXml,
        sources.evidenceBlock,
        sources.constraintBlock,
        sources.skillCandidateBlock,
    ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

/** Push a value only when it is a non-empty string. */
function pushText(out: string[], v: unknown): void {
    if (typeof v === 'string' && v.trim().length > 0) out.push(v.trim());
}

/** Section keys whose body is an experiential claim worth grounding. */
const GROUNDED_NOTE_KEYS = new Set(['stage-positioning', 'positioning', 'top-priorities', 'priorities']);

/**
 * coachingNotes is an array of { key, title, body } sections — ground the
 * experiential framing only (positioning / priorities), not advice sections
 * (pronunciation, logistics, checklist) which would add NOT_GROUNDED noise.
 * Legacy string notes ground whole.
 */
function pushCoachingNotesClaims(out: string[], notes: unknown): void {
    if (typeof notes === 'string') {
        pushText(out, notes);
        return;
    }
    if (!Array.isArray(notes)) return;
    for (const section of notes) {
        if (section === null || typeof section !== 'object') continue;
        const s = section as Record<string, unknown>;
        if (typeof s['key'] === 'string' && GROUNDED_NOTE_KEYS.has(s['key'])) pushText(out, s['body']);
    }
}

/**
 * Concatenate the coach output's *experiential* claim surfaces — the text that
 * asserts something about the candidate's real experience and could therefore
 * hallucinate. Pure advice (study guides, generic prep checklists, questions to
 * ask) is deliberately excluded: it is not a claim about the candidate, so
 * verifying it against the analysis only generates false NOT_GROUNDED noise.
 */
export function extractCoachClaims(coaching: InterviewCoachResult): string {
    const c = coaching as unknown as Record<string, unknown>;
    const out: string[] = [];

    pushText(out, c['stageDescription']);
    pushText(out, c['careerArcSummary']);
    pushCoachingNotesClaims(out, c['coachingNotes']);

    for (const tp of (c['jdTalkingPoints'] as Array<Record<string, unknown>> | undefined) ?? []) {
        pushText(out, tp['point']);
        pushText(out, tp['evidence']);
    }

    for (const key of ['technicalQuestions', 'behaviouralQuestions']) {
        for (const q of (c[key] as Array<Record<string, unknown>> | undefined) ?? []) {
            pushText(out, q['answerFramework']);
            pushText(out, q['sourceProject']);
        }
    }

    // Only non-gap skill-transfer narratives are experiential claims. Gap entries
    // honestly assert *absence* of evidence, so they need no grounding check.
    for (const e of (c['skillTransfer'] as Array<Record<string, unknown>> | undefined) ?? []) {
        if (e['tier'] === 'gap') continue;
        pushText(out, e['narrative']);
    }

    return out.join('\n');
}
