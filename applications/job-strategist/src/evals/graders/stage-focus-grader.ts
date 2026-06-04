/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';

/**
 * Heuristic branch-focus check (field presence only — deep judgment is Tier 2's
 * job). Keyed directly on the canonical stage values so it carries no dependency
 * on the prompt-refactor resolver.
 */
export const stageFocusGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const s = input.stage;

    if (s === 'phone-screen') {
        if (!output.careerArcSummary) failures.push('phone-screen: missing careerArcSummary content');
        if (!output.compScript) failures.push('phone-screen: missing compScript');
        if (!(output.jdTalkingPoints && output.jdTalkingPoints.length > 0)) failures.push('phone-screen: empty jdTalkingPoints');
    } else if (s === 'technical-1' || s === 'technical-2' || s === 'system-design') {
        // Project-anchored stages: when candidate evidence exists, the coach must
        // emit skillTransfer entries (system-design reuses the same machinery).
        const hasCandidates = input.candidateSets.some(set => set.candidates.length > 0);
        const hasTransfer = !!(output.skillTransfer && output.skillTransfer.length > 0);
        if (hasCandidates && !hasTransfer) failures.push(`${s}: candidates present but skillTransfer empty`);
    } else if (s === 'behavioural') {
        if (!(output.behaviouralQuestions && output.behaviouralQuestions.length > 0)) failures.push('behavioural: no behaviouralQuestions');
    }

    return mkResult('stage-focus', failures);
};
