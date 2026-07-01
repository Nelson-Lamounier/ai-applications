/** @format */
import type { Pool, PoolClient } from 'pg';

/** A measured number extracted from repo evidence, safe for the Writer to cite. */
export interface VerifiedMetric {
    readonly label: string;
    readonly value: string;
    readonly unit?: string;
    readonly source?: string;
}

/** A citation to the repo evidence a candidate was derived from. */
export interface EvidenceRef {
    readonly type: 'commit' | 'pr' | 'file' | 'readme';
    readonly ref: string;
    readonly url?: string;
}

/** Input to create a topic candidate (github_repo_id is BIGINT — pass as string). */
export interface ArticleTopicCandidateInput {
    readonly userId:               string;
    readonly githubRepoId:         string;
    readonly repoFullName?:        string;
    readonly projectId?:           string;
    readonly sourcePipelineRunId?: string;
    readonly title:                string;
    readonly problem:              string;
    readonly angle?:               string;
    readonly primaryKeyword?:      string;
    readonly evidenceRefs?:        readonly EvidenceRef[];
    readonly verifiedMetrics?:     readonly VerifiedMetric[];
    readonly skills?:              readonly string[];
}

export type ArticleTopicCandidateStatus = 'suggested' | 'used' | 'dismissed';

export interface ArticleTopicCandidate {
    readonly id:               string;
    readonly userId:           string;
    readonly githubRepoId:     string;
    readonly repoFullName:     string | null;
    readonly title:            string;
    readonly problem:          string;
    readonly angle:            string | null;
    readonly primaryKeyword:   string | null;
    readonly evidenceRefs:     EvidenceRef[];
    readonly verifiedMetrics:  VerifiedMetric[];
    readonly skills:           string[];
    readonly status:           ArticleTopicCandidateStatus;
    readonly usedArticleSlug:  string | null;
    readonly createdAt:        Date;
    readonly updatedAt:        Date;
}

function rowToCandidate(row: Record<string, unknown>): ArticleTopicCandidate {
    return {
        id:              row['id']                     as string,
        userId:          row['user_id']                as string,
        githubRepoId:    String(row['github_repo_id']),
        repoFullName:    (row['repo_full_name']        as string | null) ?? null,
        title:           row['title']                  as string,
        problem:         row['problem']                as string,
        angle:           (row['angle']                 as string | null) ?? null,
        primaryKeyword:  (row['primary_keyword']       as string | null) ?? null,
        evidenceRefs:    (row['evidence_refs']         as EvidenceRef[])    ?? [],
        verifiedMetrics: (row['verified_metrics']      as VerifiedMetric[]) ?? [],
        skills:          (row['skills']                as string[])         ?? [],
        status:          row['status']                 as ArticleTopicCandidateStatus,
        usedArticleSlug: (row['used_article_slug']     as string | null) ?? null,
        createdAt:       row['created_at']             as Date,
        updatedAt:       row['updated_at']             as Date,
    };
}

/**
 * Persistence for article topic candidates mined from case-study evidence.
 *
 * Candidates are keyed by github_repo_id (the canonical repo anchor that
 * survives renames) and scoped by user_id, so a future v2 can open the feature
 * to non-admin users without a schema change.
 */
export class ArticleTopicCandidateRepository {
    constructor(private readonly pool: Pool) {}

    /**
     * Replace the 'suggested' candidates for a repo with a freshly-derived set.
     *
     * Discovery re-runs on every case-study generation; re-running must not
     * accumulate duplicates. 'used' and 'dismissed' candidates are preserved —
     * only the still-open 'suggested' set is swapped. Runs in a transaction so a
     * repo is never left with zero candidates mid-swap.
     */
    async replaceSuggestedForRepo(
        userId: string,
        githubRepoId: string,
        candidates: readonly ArticleTopicCandidateInput[],
    ): Promise<void> {
        const client: PoolClient = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `DELETE FROM article_topic_candidates
                  WHERE user_id = $1 AND github_repo_id = $2 AND status = 'suggested'`,
                [userId, githubRepoId],
            );
            for (const c of candidates) {
                await client.query(
                    `INSERT INTO article_topic_candidates (
                        user_id, github_repo_id, repo_full_name, project_id,
                        source_pipeline_run_id, title, problem, angle,
                        primary_keyword, evidence_refs, verified_metrics, skills
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
                    [
                        c.userId,
                        c.githubRepoId,
                        c.repoFullName ?? null,
                        c.projectId ?? null,
                        c.sourcePipelineRunId ?? null,
                        c.title,
                        c.problem,
                        c.angle ?? null,
                        c.primaryKeyword ?? null,
                        JSON.stringify(c.evidenceRefs ?? []),
                        JSON.stringify(c.verifiedMetrics ?? []),
                        [...(c.skills ?? [])],
                    ],
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /** List candidates for a repo, newest first, optionally filtered by status. */
    async listByRepo(
        userId: string,
        githubRepoId: string,
        status?: ArticleTopicCandidateStatus,
    ): Promise<ArticleTopicCandidate[]> {
        const params: unknown[] = [userId, githubRepoId];
        let statusClause = '';
        if (status) {
            params.push(status);
            statusClause = ` AND status = $3`;
        }
        const result = await this.pool.query(
            `SELECT * FROM article_topic_candidates
              WHERE user_id = $1 AND github_repo_id = $2${statusClause}
              ORDER BY created_at DESC`,
            params,
        );
        return (result.rows as Record<string, unknown>[]).map(rowToCandidate);
    }

    /** Mark a candidate 'used' and record the article slug it became. */
    async markUsed(id: string, slug: string): Promise<void> {
        await this.pool.query(
            `UPDATE article_topic_candidates
                SET status = 'used', used_article_slug = $2, updated_at = NOW()
              WHERE id = $1`,
            [id, slug],
        );
    }

    /** Mark a candidate 'dismissed' so it no longer appears in the suggested set. */
    async markDismissed(id: string): Promise<void> {
        await this.pool.query(
            `UPDATE article_topic_candidates
                SET status = 'dismissed', updated_at = NOW()
              WHERE id = $1`,
            [id],
        );
    }
}
