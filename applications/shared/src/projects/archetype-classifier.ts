/** @format */
import type { ArchetypeDef } from './archetype-types.js';

function priorFor(projectType: string): string | null {
    switch (projectType) {
        case 'production_saas': return 'production_saas';
        case 'open_source':     return 'open_source_library';
        case 'internal_tool':   return 'internal_tool';
        default:                return null;
    }
}
function scoreArchetype(def: ArchetypeDef, signals: Record<string, boolean>): number {
    const s = def.classificationSignals;
    let score = 0;
    if (s.required_any && s.required_any.some(k => signals[k])) score += 2;
    for (const k of s.positive ?? []) if (signals[k]) score += 1;
    for (const k of s.negative ?? []) if (signals[k]) score -= 2;
    return score;
}
export function classifyArchetype(
    signals: Record<string, boolean>,
    projectType: string,
    archetypes: readonly ArchetypeDef[],
): { archetypeId: string; confidence: number } | null {
    if (!signals || Object.keys(signals).length === 0) return null;
    const prior = priorFor(projectType);
    let best: { id: string; score: number } | null = null;
    for (const def of archetypes) {
        let score = scoreArchetype(def, signals);
        if (prior && def.id === prior) score += 1;
        if (best === null || score > best.score) best = { id: def.id, score };
    }
    if (!best || best.score <= 0) return null;
    return { archetypeId: best.id, confidence: Math.min(1, best.score / 4) };
}
