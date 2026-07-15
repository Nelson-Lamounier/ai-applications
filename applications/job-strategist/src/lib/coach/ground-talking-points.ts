/** @format */
import type { PhoneScreenTalkingPoint } from '@bedrock/shared';

/**
 * Fail-closed grounding for phone-screen talking points: every matchedSkills
 * entry must be a research verified-match skill. Unverified skills are dropped;
 * a point survives only if it still cites >=1 verified skill OR cited none to
 * begin with (legacy / general points). Case-insensitive match.
 */
export function groundTalkingPoints(
    points: readonly PhoneScreenTalkingPoint[],
    verifiedSkills: readonly string[],
): PhoneScreenTalkingPoint[] {
    const verified = new Set(verifiedSkills.map(s => s.trim().toLowerCase()));
    const out: PhoneScreenTalkingPoint[] = [];
    for (const p of points) {
        const cited = p.matchedSkills ?? [];
        if (cited.length === 0) { out.push(p); continue; }
        const kept = cited.filter(s => verified.has(s.trim().toLowerCase()));
        if (kept.length === 0) continue;
        out.push({ ...p, matchedSkills: kept });
    }
    return out;
}
