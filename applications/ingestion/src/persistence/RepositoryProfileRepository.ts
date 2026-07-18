import type { Pool } from 'pg';
import { withUserRls } from '@bedrock/shared';
import type { ExtractedRepoData } from '../narrative/ProfileExtractor.js';
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
    /** Skip-unchanged hash of the extract inputs (HEAD sha + extractor version/model). */
    profileInputHash?:  string;
}

export interface RepositoryProfile {
    id:               string;
    userId:           string;
    repoFullName:     string;
    extractionStatus: string;
}

/** JSON-encode a value for a jsonb column, defaulting an absent value to an empty object. */
function jsonOrEmpty(value: unknown): string {
    return value ? JSON.stringify(value) : '{}';
}

/** Positional params for the `upsert` INSERT, extracted to keep the withUserRls callback's complexity under the lint gate. */
function upsertParams(input: UpsertProfileInput): unknown[] {
    return [
        input.userId,
        input.repositoryId ?? null,
        input.repoFullName,
        jsonOrEmpty(input.extracted),
        input.classification ?? null,
        input.qualityScore ?? 0,
        jsonOrEmpty(input.qualityBreakdown),
        input.extractionStatus,
        input.extractionError ?? null,
        input.extractedAt ?? null,
        input.extractorModel ?? null,
        input.extractorVersion ?? null,
        input.profileInputHash ?? null,
    ];
}

export class RepositoryProfileRepository {
    constructor(private readonly pool: Pool) {}

    async upsert(input: UpsertProfileInput): Promise<{ id: string }> {
        return withUserRls(this.pool, input.userId, async (client) => {
            const result = await client.query<{ id: string }>(
                `INSERT INTO repository_profiles (
                    user_id, repository_id, repo_full_name,
                    extracted, classification,
                    quality_score, quality_breakdown,
                    extraction_status, extraction_error,
                    extracted_at, extractor_model, extractor_version,
                    profile_input_hash
                ) VALUES (
                    $1::uuid, $2::uuid, $3,
                    $4::jsonb, $5,
                    $6, $7::jsonb,
                    $8, $9,
                    $10, $11, $12,
                    $13
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
                    profile_input_hash = COALESCE(EXCLUDED.profile_input_hash, repository_profiles.profile_input_hash),
                    updated_at         = now()
                RETURNING id`,
                upsertParams(input),
            );

            const row = result.rows[0];
            if (!row) {
                throw new Error(
                    `upsert returned no row for user=${input.userId} repo=${input.repoFullName}; ` +
                    `check RLS RETURNING policy on repository_profiles`,
                );
            }
            return { id: row.id };
        });
    }

    async findByUserAndRepo(
        userId: string,
        repoFullName: string,
    ): Promise<RepositoryProfile | null> {
        return withUserRls(this.pool, userId, async (client) => {
            const result = await client.query<RepositoryProfile>(
                `SELECT id, user_id AS "userId", repo_full_name AS "repoFullName",
                        extraction_status AS "extractionStatus"
                   FROM repository_profiles
                  WHERE user_id = $1::uuid AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            return result.rows[0] ?? null;
        });
    }

    /**
     * Read the skip-unchanged state for the extract gate (WS4): the stored input
     * hash + current extraction status. Null when the repo has no profile yet.
     */
    async getInputState(
        userId: string,
        repoFullName: string,
    ): Promise<{ inputHash: string | null; extractionStatus: string } | null> {
        const { rows } = await this.pool.query<{ profile_input_hash: string | null; extraction_status: string }>(
            `SELECT profile_input_hash, extraction_status
               FROM repository_profiles WHERE user_id = $1::uuid AND repo_full_name = $2`,
            [userId, repoFullName],
        );
        if (rows.length === 0) return null;
        return { inputHash: rows[0].profile_input_hash ?? null, extractionStatus: rows[0].extraction_status };
    }

    async updateStatus(
        id: string,
        userId: string,
        status: 'completed' | 'failed',
        error?: string,
    ): Promise<void> {
        await withUserRls(this.pool, userId, async (client) => {
            await client.query(
                `UPDATE repository_profiles
                    SET extraction_status = $1,
                        extraction_error  = $2,
                        updated_at        = now()
                  WHERE id = $3::uuid
                    AND user_id = $4::uuid`,
                [status, error ?? null, id, userId],
            );
        });
    }
}
