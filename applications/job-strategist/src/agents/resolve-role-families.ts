/** @format */
import type { Pool } from 'pg';
import { RoleOntologyRepository, log } from '@bedrock/shared';
import type { CompanyType, RoleFamily } from '@bedrock/shared';
import { classifyRole } from './role-classifier.js';

const QUORUM = Number(process.env['ROLE_LEARNING_QUORUM'] ?? '3');
const FAMILY_QUORUM = Number(process.env['ROLE_FAMILY_QUORUM'] ?? '5');

export interface ResolvedRole {
    title:       string;
    company:     string;
    family:      RoleFamily | null;
    matchVia:    'alias' | 'classifier' | 'none';
    companyType?: CompanyType;
}

function normaliseTitle(t: string): string { return t.toLowerCase().trim(); }

/** Match a title against the alias map by exact + word-bounded containment. */
function aliasLookup(title: string, aliasMap: Map<string, string>): string | null {
    const n = normaliseTitle(title);
    if (aliasMap.has(n)) return aliasMap.get(n) ?? null;
    const padded = ` ${n} `;
    for (const [alias, family] of aliasMap) {
        if (padded.includes(` ${alias} `)) return family;
    }
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
    let knownKeys: string[];
    try {
        [aliasMap, families, knownKeys] = await Promise.all([
            repo.loadAliasMap(),
            repo.loadFamilies(),
            repo.loadAllFamilyKeys(),
        ]);
    } catch (e) {
        log('WARN', 'role ontology load failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
        return experiences.map((x) => ({ title: x.title, company: x.company, family: null, matchVia: 'none' }));
    }
    const byKey = new Map(families.map((f) => [f.familyKey, f]));
    const allKeySet = new Set(knownKeys);

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
                // GROUNDED family — stage learning candidates + thread companyType
                await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'alias', value: normaliseTitle(x.title), contributingUserId: userId });
                for (const v of cls.suggestedVocabulary) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'vocabulary', value: v, contributingUserId: userId });
                for (const s of cls.suggestedTransferableSkills) await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'transferable_skill', value: s, contributingUserId: userId });
                await repo.incrementPopularity(cls.familyKey);
                out.push({ title: x.title, company: x.company, family: byKey.get(cls.familyKey) ?? null, matchVia: 'classifier', companyType: cls.companyType });
                continue;
            }
            if (cls && allKeySet.has(cls.familyKey)) {
                // CANDIDATE family (in ontology but not grounded yet) — record a family vote
                await repo.stageCandidate({ familyKey: cls.familyKey, candidateType: 'family', value: cls.familyKey, contributingUserId: userId });
                out.push({ title: x.title, company: x.company, family: null, matchVia: 'none', companyType: cls.companyType });
                continue;
            }
            if (cls?.newFamily) {
                // NOVEL family — insert as candidate then stage a vote
                await repo.insertCandidateFamily(cls.newFamily);
                await repo.stageCandidate({ familyKey: cls.newFamily.familyKey, candidateType: 'family', value: cls.newFamily.familyKey, contributingUserId: userId });
                out.push({ title: x.title, company: x.company, family: null, matchVia: 'none', companyType: cls.companyType });
                continue;
            }
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        } catch (e) {
            log('WARN', 'role resolve failed for entry (non-fatal)', { title: x.title, error: e instanceof Error ? e.message : String(e) });
            out.push({ title: x.title, company: x.company, family: null, matchVia: 'none' });
        }
    }
    await repo.promote(QUORUM, FAMILY_QUORUM).catch(() => undefined);
    return out;
}
