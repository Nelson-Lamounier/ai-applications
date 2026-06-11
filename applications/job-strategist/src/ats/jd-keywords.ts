/** @format */
import type { StrategistResearchResult } from '@bedrock/shared';
import type { JdExtraction } from '../agents/jd-extractor.js';

/** JD must-have terms = hard-requirement skills + infrastructure + tools. */
export function collectJdMustHaves(r: StrategistResearchResult): string[] {
    const out = new Set<string>();
    for (const req of r.hardRequirements) if (req.skill.trim()) out.add(req.skill.trim());
    for (const t of r.technologyInventory.infrastructure) if (t.trim()) out.add(t.trim());
    for (const t of r.technologyInventory.tools) if (t.trim()) out.add(t.trim());
    return [...out];
}

/** v2 atomic must-haves: prefer the JD-extractor's atomic terms; fallback to research. Cap 18. */
export function collectJdMustHavesV2(jd: JdExtraction | null, r: StrategistResearchResult): string[] {
    const out = new Set<string>();
    const add = (arr: string[]) => {
        for (const t of arr) {
            const s = t.trim();
            if (s) out.add(s);
        }
    };
    if (jd !== null && (jd.requiredSkills.length + jd.tools.length + jd.concepts.length) > 0) {
        add(jd.requiredSkills);
        add(jd.tools);
        add(jd.concepts);
    } else {
        add(collectJdMustHaves(r));
    }
    return [...out].slice(0, 18);
}

/** Lowercased set of terms with KB evidence (verified or partial matches). */
export function collectGroundedTerms(r: StrategistResearchResult): Set<string> {
    const s = new Set<string>();
    for (const m of r.verifiedMatches) s.add(m.skill.toLowerCase());
    for (const m of r.partialMatches) s.add(m.skill.toLowerCase());
    return s;
}
