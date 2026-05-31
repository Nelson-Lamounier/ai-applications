/** @format */
import type { StageId } from './archetype-types.js';

const LEVEL_TO_STAGE: Record<string, StageId> = {
    'junior': 'junior', 'mid': 'mid', 'mid-senior': 'senior', 'senior': 'senior', 'staff+': 'staff',
};
const STAGE_RANK: Record<StageId, number> = { junior: 0, mid: 1, senior: 2, staff: 3 };

export function mapSeniorityLevel(level: string): StageId | null {
    return LEVEL_TO_STAGE[level] ?? null;
}
export function pickStage(seniority: ReadonlyArray<{ area: string; level: string }>): StageId | null {
    let best: StageId | null = null;
    for (const s of seniority) {
        const stage = mapSeniorityLevel(s.level);
        if (stage && (best === null || STAGE_RANK[stage] > STAGE_RANK[best])) best = stage;
    }
    return best;
}
