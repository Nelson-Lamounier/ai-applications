/** @format */
import type { Pool } from 'pg';
import type { SkillGap } from '@bedrock/shared';

/**
 * Why a JD skill ended up in the research `gaps` list — the demand-side
 * failure taxonomy that turns the gap log into an actionable signal:
 *
 * - `kb_present_not_retrieved`: chunks mentioning the skill EXIST in the
 *   user's KB but the research retrieval did not surface them (or the
 *   assessment judged them insufficient). Retrieval/assessment tuning lead.
 * - `kb_no_evidence`: nothing in the ingested KB mentions the skill. Either
 *   the evidence never made it through ingestion or it does not exist on the
 *   user's GitHub at all — indistinguishable from inside the KB, and both
 *   resolve to the same user-facing action: document or build the evidence.
 */
export type GapCause = 'kb_present_not_retrieved' | 'kb_no_evidence';

export type SkillGapWithCause = SkillGap & { readonly gapCause: GapCause };

/**
 * fileClass lanes whose lexical hits are noise, not evidence: a skill name
 * appearing only in config values or data fixtures does not indicate the
 * user practised it (the retrieval weights already down-rank these lanes).
 * Excluding them keeps the corrective-retrieval pass from chasing ghosts.
 * Unstamped chunks (no fileClass, pre-restamp) fail open and still count.
 */
export const NOISE_FILE_CLASSES = ['config', 'data'] as const;

/**
 * Classify every gap in one round-trip using the generated `content_tsv`
 * full-text column (multi-word skills like "Google Cloud Platform" match as
 * a phrase-agnostic AND, which ILIKE cannot do). Presence is scoped to
 * evidence-bearing fileClass lanes — see NOISE_FILE_CLASSES.
 */
export async function classifyGapCauses(
    pool: Pool,
    userId: string,
    skills: readonly string[],
): Promise<Map<string, GapCause>> {
    const causes = new Map<string, GapCause>();
    if (skills.length === 0) return causes;
    const res = await pool.query<{ skill: string; present: boolean }>(
        `SELECT s.skill,
                EXISTS (
                    SELECT 1 FROM document_embeddings de
                    WHERE de.user_id = $1
                      AND COALESCE(de.metadata->>'fileClass', '') <> ALL($3::text[])
                      AND de.content_tsv @@ plainto_tsquery('english', s.skill)
                ) AS present
         FROM unnest($2::text[]) AS s(skill)`,
        [userId, [...skills], [...NOISE_FILE_CLASSES]],
    );
    for (const row of res.rows) {
        causes.set(row.skill, row.present ? 'kb_present_not_retrieved' : 'kb_no_evidence');
    }
    return causes;
}

/**
 * Annotate research gaps with their cause. Fail-open by contract: callers
 * catch and keep the un-annotated gaps — classification is observability,
 * never a pipeline dependency. `onCause` lets the caller count causes into
 * its metrics registry without this module owning a Counter.
 */
export async function annotateGapCauses(
    pool: Pool,
    userId: string,
    gaps: readonly SkillGap[],
    onCause?: (cause: GapCause) => void,
): Promise<SkillGapWithCause[]> {
    const causes = await classifyGapCauses(pool, userId, gaps.map((g) => g.skill));
    return gaps.map((g) => {
        const gapCause = causes.get(g.skill) ?? 'kb_no_evidence';
        onCause?.(gapCause);
        return { ...g, gapCause };
    });
}
