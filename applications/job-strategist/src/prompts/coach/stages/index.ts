/** @format */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { InterviewStage } from '@bedrock/shared';
import { COACH_BASE_TEXT } from '../base.js';
import { PHONE_SCREEN_DELTA } from './phone-screen.js';
import { TECHNICAL_DELTA } from './technical.js';
import { BEHAVIOURAL_DELTA } from './behavioural.js';
import { SYSTEM_DESIGN_DELTA } from './system-design.js';
import { BAR_RAISER_DELTA } from './bar-raiser.js';
import { FINAL_DELTA } from './final.js';

export type CoachBranch =
    | 'phone-screen' | 'technical' | 'system-design' | 'behavioural' | 'bar-raiser' | 'final' | 'general';

/**
 * Map a canonical interview stage to its coach branch. `bar-raiser` and `final`
 * are prep stages carried as strings by the dispatch layer (INTERVIEW_PREP_STAGES);
 * they are not in the lifecycle `InterviewStage` union, so they are matched
 * defensively on the widened string.
 */
export function resolveCoachBranch(stage: InterviewStage): CoachBranch {
    if ((stage as string) === 'bar-raiser') return 'bar-raiser';
    if ((stage as string) === 'final') return 'final';
    switch (stage) {
        case 'phone-screen': return 'phone-screen';
        case 'technical-1':
        case 'technical-2': return 'technical';
        case 'system-design': return 'system-design';
        case 'behavioural': return 'behavioural';
        default: return 'general';
    }
}

/**
 * Branches whose coaching is anchored in project evidence (the candidate block +
 * runtime validateSkillTransfer). run-coach uses this to decide whether to build
 * skill-candidate sets; the stage-focus grader uses it to require skillTransfer.
 * Technical only now — system-design has its own project-anchored walkthrough gate.
 */
export function stageUsesSkillTransfer(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'technical';
}

/** Project-anchored system-design walkthrough stage. */
export function stageUsesSystemDesignWalkthrough(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'system-design';
}

/** Project-anchored bar-raiser leadership-principle walkthrough stage. */
export function stageUsesBarRaiserWalkthrough(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'bar-raiser';
}

/** Final-round / mutual-fit preparation stage (why-this-role + substantive questions). */
export function stageUsesFinalPrep(stage: InterviewStage): boolean {
    return resolveCoachBranch(stage) === 'final';
}

const DELTA: Record<CoachBranch, string> = {
    'phone-screen': PHONE_SCREEN_DELTA,
    technical: TECHNICAL_DELTA,
    'system-design': SYSTEM_DESIGN_DELTA,
    behavioural: BEHAVIOURAL_DELTA,
    'bar-raiser': BAR_RAISER_DELTA,
    final: FINAL_DELTA,
    general: '',
};

/**
 * Assemble the stage-specific system prompt: shared base, cache point (so the large
 * base is cached across all stages), then the small stage delta. The model only ever
 * sees its own branch — no self-selection among branches it shouldn't be on.
 */
export function assembleCoachSystemPrompt(stage: InterviewStage): SystemContentBlock[] {
    const delta = DELTA[resolveCoachBranch(stage)];
    const blocks: SystemContentBlock[] = [
        { text: COACH_BASE_TEXT },
        { cachePoint: { type: 'default' } } as SystemContentBlock,
    ];
    if (delta) blocks.push({ text: delta });
    return blocks;
}
