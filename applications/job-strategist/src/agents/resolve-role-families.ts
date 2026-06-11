/** @format */
import type { Pool } from 'pg';
import { RoleOntologyRepository, log } from '@bedrock/shared';
import type { RoleFamily } from '@bedrock/shared';
import { classifyRole } from './role-classifier.js';

const QUORUM = Number(process.env['ROLE_LEARNING_QUORUM'] ?? '3');

export interface ResolvedRole {
    title:    string;
    company:  string;
    family:   RoleFamily | null;
    matchVia: 'alias' | 'classifier' | 'none';
}

function normaliseTitle(t: string): string { return t.toLowerCase().trim(); }

/** Match a title against the alias map by exact + substring containment. */
function aliasLookup(title: string, aliasMap: Map<string, string>): string | null {
    const n = normaliseTitle(title);
    if (aliasMap.has(n)) return aliasMap.get(n) ?? null;
    for (const [alias, family] of aliasMap) if (n.includes(alias)) return family;
    return null;
}

/**
 * Resolve each experience to a role family via the cascade (alias → classifier),
 * staging learning candidates + promoting on quorum. FAIL-OPEN per entry: a null
 * family on any error. (Tavily family-discovery is the documented Phase-2 last
 * resort and is intentionally not wired here; classifier-miss yields null.)
 */
export async function resolveRoleFamilies(
    pool: Pool,
    userId: string,
    experiences: Array<{ title: string; company: string; highlights: string[] }>,
    repo: RoleOntologyRepository = new RoleOntologyRepository(pool),
): Promise<ResolvedRole[]> {
    let aliasMap: Map<string, string>;
    let families: RoleFamily[];
    try {
        [aliasMap, families] = await Promise.all([repo.loadAliasMap(), repo.loadFamilies()]);
    } catch (e) {
        log('WARN', 'role ontology load failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
        return experiences.map((x) => ({ title: x.title, company: x.company, family: null, matchVia: 'none' }));
    }
    const byKey = new Map(families.map((f) => [f.familyKey, f]));
    const knownKeys = families.map((f) => f.familyKey);

    const out: ResolvedRole[] = [];
    for (const x of experiences) {
        try {
            const aliasHit = aliasLookup(x.title, aliasMap);
            if (aliasHit && byKey.has(aliasHit)) {
                await repo.incrementPopularity(aliasHit);
                out.push({ title: x.title, company: x.company, family: byKey.get(aliasHit) ?? null, matchVia: 'alias' });
                continue;
            }
            const cls = await classifyRole({ title: x.title, company: x.company, highlights: x.highlights }, knownKeys);
            if (cls && byKey.has(cls.familyKey)) {
                await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'alias', value: normaliseTitle(x.title), contributingUserId: userId });
                for (const v of cls.suggestedVocabulary) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'vocabulary', value: v, contributingUserId: userId });
                for (const s of cls.suggestedTransferableSkills) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'transferable_skill', value: s, contributingUserId: userId });
                await repo.incrementPopularity(cls.familyKey);
                out.push({ title: x.title, company: x.company, family: byKey.get(cls.familyKey) ?? null, matchVia: 'classifier' });
                continue;
            }
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        } catch (e) {
            log('WARN', 'role resolve failed for entry (non-fatal)', { title: x.title, error: e instanceof Error ? e.message : String(e) });
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        }
    }
    await repo.promote(QUORUM).catch(() => undefined);
    return out;
}
