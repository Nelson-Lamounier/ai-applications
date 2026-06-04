/**
 * @format
 * Coach prose extractor — turns InterviewCoachResult into tagged ProseSection[]
 * for BedrockProseLinter. Sibling to coach-grounding.ts's extractCoachClaims: same
 * experiential surfaces, but each becomes a located, register-tagged section so the
 * linter can attribute issues and calibrate by voice. Gap skill-transfer entries
 * are excluded (they assert absence of evidence, not a prose claim).
 */
import type { InterviewCoachResult, ProseSection, ProseRegister } from '@bedrock/shared';

function push(out: ProseSection[], location: string, register: ProseRegister, v: unknown): void {
    if (typeof v === 'string' && v.trim().length > 0) {
        out.push({ location, register, text: v.trim() });
    }
}

export function extractProseSections(coaching: InterviewCoachResult): ProseSection[] {
    const c = coaching as unknown as Record<string, unknown>;
    const out: ProseSection[] = [];

    push(out, 'stageDescription', 'narrative', c['stageDescription']);
    push(out, 'careerArcSummary', 'narrative', c['careerArcSummary']);
    push(out, 'coachingNotes', 'advice', c['coachingNotes']);

    const tps = (c['jdTalkingPoints'] as Array<Record<string, unknown>> | undefined) ?? [];
    tps.forEach((tp, i) => push(out, `jdTalkingPoints[${i}].point`, 'resume-prose', tp['point']));

    for (const key of ['technicalQuestions', 'behaviouralQuestions'] as const) {
        const qs = (c[key] as Array<Record<string, unknown>> | undefined) ?? [];
        qs.forEach((q, i) => push(out, `${key}[${i}].answerFramework`, 'storytelling', q['answerFramework']));
    }

    const st = (c['skillTransfer'] as Array<Record<string, unknown>> | undefined) ?? [];
    st.forEach((e, i) => {
        if (e['tier'] === 'gap') return;
        push(out, `skillTransfer[${i}].narrative`, 'resume-prose', e['narrative']);
    });

    return out;
}
