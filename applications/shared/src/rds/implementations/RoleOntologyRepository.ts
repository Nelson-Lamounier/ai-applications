/** @format */
import type { Pool } from 'pg';
import type { CompanyType, NewFamily, RoleFamily, RoleLearningCandidate } from '../types/role-ontology.js';

interface FamilyRow {
    family_key: string; display_name: string; role_class: RoleFamily['roleClass'];
    canonical_responsibilities: string[]; vocabulary: string[]; transferable_skills: string[]; industry_notes: string;
}

/** Global role-ontology reference data (no RLS), mirrors TechnologyOntologyRepository. */
export class RoleOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** alias → family_key (lowercased), curated + learned. */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; family_key: string }>(
            `SELECT alias, family_key FROM role_aliases`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias.toLowerCase().trim(), r.family_key);
        return map;
    }

    /** Active families usable in grounding — curated + auto_imported only. */
    async loadFamilies(): Promise<RoleFamily[]> {
        const { rows } = await this.pool.query<FamilyRow>(
            `SELECT family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, industry_notes
               FROM role_ontology
              WHERE is_active = TRUE AND curation IN ('curated','auto_imported')`,
        );
        return rows.map((r) => ({
            familyKey: r.family_key, displayName: r.display_name, roleClass: r.role_class,
            canonicalResponsibilities: r.canonical_responsibilities ?? [], vocabulary: r.vocabulary ?? [],
            transferableSkills: r.transferable_skills ?? [], industryNotes: r.industry_notes ?? '',
        }));
    }

    /** Stage one learning vote (one per user via the UNIQUE constraint). */
    async stageCandidate(c: RoleLearningCandidate): Promise<void> {
        await this.pool.query(
            `INSERT INTO role_learning_candidates (family_key, candidate_type, value, contributing_user_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (family_key, candidate_type, value, contributing_user_id) DO NOTHING`,
            [c.familyKey, c.candidateType, c.value, c.contributingUserId],
        );
    }

    /** Bump usage telemetry for a matched family. */
    async incrementPopularity(familyKey: string): Promise<void> {
        await this.pool.query(`UPDATE role_ontology SET popularity_score = popularity_score + 1 WHERE family_key = $1`, [familyKey]);
    }

    /**
     * Promote candidates corroborated by >= quorum distinct users to auto_imported. Idempotent.
     * After promotion, prunes cleared candidates so the staging table stays bounded.
     * B3 quality gate on vocab/skill: only values that are non-empty after trim, <= 60 chars,
     * and not already present in the family's array are promoted.
     */
    async promote(aliasQuorum: number, vocabQuorum: number, familyQuorum: number): Promise<void> {
        // (1) Promote alias candidates
        await this.pool.query(
            `INSERT INTO role_aliases (alias, family_key, curation, source)
             SELECT value, family_key, 'auto_imported', 'learned'
               FROM role_learning_candidates
              WHERE candidate_type = 'alias'
              GROUP BY value, family_key
             HAVING COUNT(DISTINCT contributing_user_id) >= $1
             ON CONFLICT (alias) DO NOTHING`,
            [aliasQuorum],
        );
        // (2) Promote vocabulary + transferable_skill candidates (vocabQuorum, with B3 quality gate)
        await this.pool.query(
            `UPDATE role_ontology o SET
                vocabulary          = CASE WHEN c.candidate_type = 'vocabulary'
                                                AND NOT (c.value = ANY(o.vocabulary))
                                           THEN array_append(o.vocabulary, c.value) ELSE o.vocabulary END,
                transferable_skills = CASE WHEN c.candidate_type = 'transferable_skill'
                                                AND NOT (c.value = ANY(o.transferable_skills))
                                           THEN array_append(o.transferable_skills, c.value) ELSE o.transferable_skills END,
                updated_at = now()
               FROM (
                 SELECT family_key, candidate_type, value
                   FROM role_learning_candidates
                  WHERE candidate_type IN ('vocabulary','transferable_skill')
                    AND char_length(trim(value)) BETWEEN 1 AND 60
                  GROUP BY family_key, candidate_type, value
                 HAVING COUNT(DISTINCT contributing_user_id) >= $1
               ) c
              WHERE o.family_key = c.family_key`,
            [vocabQuorum],
        );
        // (3) Promote family candidates
        await this.pool.query(
            `UPDATE role_ontology SET curation = 'auto_imported', updated_at = now()
              WHERE curation = 'candidate' AND family_key IN (
                SELECT value FROM role_learning_candidates
                 WHERE candidate_type = 'family'
                 GROUP BY value
                HAVING COUNT(DISTINCT contributing_user_id) >= $1)`,
            [familyQuorum],
        );
        // (4) Prune: delete rows that have cleared their quorum (table stays bounded)
        await this.pool.query(
            `DELETE FROM role_learning_candidates
              WHERE candidate_type = 'alias'
                AND (family_key, value) IN (
                  SELECT family_key, value FROM role_learning_candidates
                   WHERE candidate_type = 'alias'
                   GROUP BY family_key, value
                  HAVING COUNT(DISTINCT contributing_user_id) >= $1)`,
            [aliasQuorum],
        );
        await this.pool.query(
            `DELETE FROM role_learning_candidates
              WHERE candidate_type IN ('vocabulary','transferable_skill')
                AND (family_key, candidate_type, value) IN (
                  SELECT family_key, candidate_type, value FROM role_learning_candidates
                   WHERE candidate_type IN ('vocabulary','transferable_skill')
                   GROUP BY family_key, candidate_type, value
                  HAVING COUNT(DISTINCT contributing_user_id) >= $1)`,
            [vocabQuorum],
        );
        await this.pool.query(
            `DELETE FROM role_learning_candidates
              WHERE candidate_type = 'family'
                AND (family_key, value) IN (
                  SELECT family_key, value FROM role_learning_candidates
                   WHERE candidate_type = 'family'
                   GROUP BY family_key, value
                  HAVING COUNT(DISTINCT contributing_user_id) >= $1)`,
            [familyQuorum],
        );
    }

    /** ALL family keys (curated+auto_imported+candidate) — feeds the classifier for convergence. */
    async loadAllFamilyKeys(): Promise<string[]> {
        const { rows } = await this.pool.query<{ family_key: string }>(
            `SELECT family_key FROM role_ontology WHERE is_active = TRUE`,
        );
        return rows.map((r) => r.family_key);
    }

    /** Insert a classifier-proposed novel family as a 'candidate' (not grounded until promoted). */
    async insertCandidateFamily(f: NewFamily): Promise<void> {
        await this.pool.query(
            `INSERT INTO role_ontology (family_key, display_name, role_class, canonical_responsibilities, vocabulary, transferable_skills, curation, source)
             VALUES ($1,$2,$3,$4,$5,$6,'candidate','classifier-learned')
             ON CONFLICT (family_key) DO NOTHING`,
            [f.familyKey, f.displayName, f.roleClass, f.canonicalResponsibilities, f.vocabulary, f.transferableSkills],
        );
    }

    /** company_type → framing note. */
    async loadCompanyFraming(): Promise<Map<CompanyType, string>> {
        const { rows } = await this.pool.query<{ company_type: CompanyType; framing_note: string }>(
            `SELECT company_type, framing_note FROM company_type_framing`,
        );
        const m = new Map<CompanyType, string>();
        for (const r of rows) m.set(r.company_type, r.framing_note);
        return m;
    }
}
