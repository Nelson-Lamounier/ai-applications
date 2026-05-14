import type { Pool } from 'pg';
import type { ExtractedRepoData } from '../agents/ProfileExtractor.js';
import type { ScoreBreakdown } from '../util/scoreProfile.js';
import type { RepoClassification } from '../util/classifyRepo.js';

export interface UpsertProfileInput {
    userId:             string;
    repositoryId?:      string | null;
    repoFullName:       string;
    extracted?:         ExtractedRepoData;
    classification?:    RepoClassification;
    qualityScore?:      number;
    qualityBreakdown?:  ScoreBreakdown;
    extractionStatus:   'pending' | 'extracting' | 'ready_for_review' | 'completed' | 'failed';
    extractionError?:   string | null;
    extractedAt?:       Date | null;
    extractorModel?:    string;
    extractorVersion?:  string;
}

export interface RepositoryProfile {
    id:               string;
    userId:           string;
    repoFullName:     string;
    extractionStatus: string;
}

export class RepositoryProfileRepository {
    constructor(private readonly pool: Pool) {}

    async upsert(input: UpsertProfileInput): Promise<{ id: string }> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [input.userId]);

            const result = await client.query<{ id: string }>(
                `INSERT INTO repository_profiles (
                    user_id, repository_id, repo_full_name,
                    extracted, classification,
                    quality_score, quality_breakdown,
                    extraction_status, extraction_error,
                    extracted_at, extractor_model, extractor_version
                ) VALUES (
                    $1::uuid, $2::uuid, $3,
                    $4::jsonb, $5,
                    $6, $7::jsonb,
                    $8, $9,
                    $10, $11, $12
                )
                ON CONFLICT (user_id, repo_full_name) DO UPDATE SET
                    repository_id      = COALESCE(EXCLUDED.repository_id, repository_profiles.repository_id),
                    extracted          = COALESCE(NULLIF(EXCLUDED.extracted, '{}'), repository_profiles.extracted),
                    classification     = COALESCE(EXCLUDED.classification, repository_profiles.classification),
                    quality_score      = COALESCE(EXCLUDED.quality_score, repository_profiles.quality_score),
                    quality_breakdown  = COALESCE(NULLIF(EXCLUDED.quality_breakdown, '{}'), repository_profiles.quality_breakdown),
                    extraction_status  = EXCLUDED.extraction_status,
                    extraction_error   = EXCLUDED.extraction_error,
                    extracted_at       = COALESCE(EXCLUDED.extracted_at, repository_profiles.extracted_at),
                    extractor_model    = COALESCE(EXCLUDED.extractor_model, repository_profiles.extractor_model),
                    extractor_version  = COALESCE(EXCLUDED.extractor_version, repository_profiles.extractor_version),
                    updated_at         = now()
                RETURNING id`,
                [
                    input.userId,
                    input.repositoryId ?? null,
                    input.repoFullName,
                    input.extracted ? JSON.stringify(input.extracted) : '{}',
                    input.classification ?? null,
                    input.qualityScore ?? 0,
                    input.qualityBreakdown ? JSON.stringify(input.qualityBreakdown) : '{}',
                    input.extractionStatus,
                    input.extractionError ?? null,
                    input.extractedAt ?? null,
                    input.extractorModel ?? null,
                    input.extractorVersion ?? null,
                ],
            );

            await client.query('COMMIT');
            const row = result.rows[0];
            if (!row) {
                throw new Error(
                    `upsert returned no row for user=${input.userId} repo=${input.repoFullName}; ` +
                    `check RLS RETURNING policy on repository_profiles`,
                );
            }
            return { id: row.id };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async findByUserAndRepo(
        userId: string,
        repoFullName: string,
    ): Promise<RepositoryProfile | null> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [input.userId]);
            const result = await client.query<RepositoryProfile>(
                `SELECT id, user_id AS "userId", repo_full_name AS "repoFullName",
                        extraction_status AS "extractionStatus"
                   FROM repository_profiles
                  WHERE user_id = $1::uuid AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            await client.query('COMMIT');
            return result.rows[0] ?? null;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async updateStatus(
        id: string,
        userId: string,
        status: 'completed' | 'failed',
        error?: string,
    ): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `UPDATE repository_profiles
                    SET extraction_status = $1,
                        extraction_error  = $2,
                        updated_at        = now()
                  WHERE id = $3::uuid
                    AND user_id = $4::uuid`,
                [status, error ?? null, id, userId],
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
