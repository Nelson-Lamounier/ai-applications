/** @format */
import { mkResult } from '../graders.js';
import type { Grader, EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

/** Stages anchored in project evidence — system-design reuses the technical machinery. */
const PROJECT_ANCHORED = new Set(['technical-1', 'technical-2', 'system-design']);

function phoneScreenFailures(o: InterviewCoachResult): string[] {
    const f: string[] = [];
    if (!o.careerArcSummary) f.push('phone-screen: missing careerArcSummary content');
    if (!o.compScript) f.push('phone-screen: missing compScript');
    if (!(o.jdTalkingPoints && o.jdTalkingPoints.length > 0)) f.push('phone-screen: empty jdTalkingPoints');
    return f;
}

/** Project-anchored stages: when candidate evidence exists, skillTransfer must be emitted. */
function skillTransferFailures(stage: string, input: EvalInput, o: InterviewCoachResult): string[] {
    const hasCandidates = input.candidateSets.some(set => set.candidates.length > 0);
    const hasTransfer = !!(o.skillTransfer && o.skillTransfer.length > 0);
    return hasCandidates && !hasTransfer ? [`${stage}: candidates present but skillTransfer empty`] : [];
}

function behaviouralFailures(o: InterviewCoachResult): string[] {
    return o.behaviouralQuestions && o.behaviouralQuestions.length > 0
        ? []
        : ['behavioural: no behaviouralQuestions'];
}

/**
 * Heuristic branch-focus check (field presence only — deep judgment is Tier 2's
 * job). Keyed directly on the canonical stage values so it carries no dependency
 * on the prompt-refactor resolver; per-branch checks live in small helpers.
 */
export const stageFocusGrader: Grader = (input, output) => {
    const s = input.stage;
    let failures: string[] = [];
    if (s === 'phone-screen') failures = phoneScreenFailures(output);
    else if (PROJECT_ANCHORED.has(s)) failures = skillTransferFailures(s, input, output);
    else if (s === 'behavioural') failures = behaviouralFailures(output);
    return mkResult('stage-focus', failures);
};
