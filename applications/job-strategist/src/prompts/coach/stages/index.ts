/** @format */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { InterviewStage } from '@bedrock/shared';
import { COACH_BASE_TEXT } from '../base.js';
import { PHONE_SCREEN_DELTA } from './phone-screen.js';
import { TECHNICAL_DELTA } from './technical.js';
import { BEHAVIOURAL_DELTA } from './behavioural.js';

export type CoachBranch = 'phone-screen' | 'technical' | 'behavioural' | 'general';

/** Map a canonical interview stage to its coach branch. */
export function resolveCoachBranch(stage: InterviewStage): CoachBranch {
    switch (stage) {
        case 'phone-screen': return 'phone-screen';
        case 'technical-1':
        case 'technical-2': return 'technical';
        case 'behavioural': return 'behavioural';
        default: return 'general';
    }
}

const DELTA: Record<CoachBranch, string> = {
    'phone-screen': PHONE_SCREEN_DELTA,
    technical: TECHNICAL_DELTA,
    behavioural: BEHAVIOURAL_DELTA,
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
