/**
 * @format
 * AuroraSyncStateRepository — ISyncStateRepository backed by Aurora Data API
 *
 * All operations target the repo_sync_state table.
 * Single responsibility: sync state persistence — no vector operations.
 */

import {
    RDSDataClient,
    ExecuteStatementCommand,
    type Field,
    type SqlParameter,
} from '@aws-sdk/client-rds-data';

import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { RepoSyncState, SyncStatus } from '../types.js';
import type { AuroraClientConfig } from './AuroraVectorStore.js';

export class AuroraSyncStateRepository implements ISyncStateRepository {
    private readonly client: RDSDataClient;
    private readonly config: AuroraClientConfig;

    constructor(config: AuroraClientConfig) {
        this.config = config;
        this.client = new RDSDataClient({});
    }

    static fromEnvironment(): AuroraSyncStateRepository {
        const resourceArn = process.env.AURORA_CLUSTER_ARN;
        const secretArn   = process.env.AURORA_SECRET_ARN;
        const database    = process.env.AURORA_DB_NAME;

        if (!resourceArn || !secretArn || !database) {
            throw new Error(
                'AuroraSyncStateRepository: missing environment variables. ' +
                'Required: AURORA_CLUSTER_ARN, AURORA_SECRET_ARN, AURORA_DB_NAME',
            );
        }

        return new AuroraSyncStateRepository({ resourceArn, secretArn, database });
    }

    // =========================================================================
    // ISyncStateRepository.get
    // =========================================================================

    async get(userId: string, repoFullName: string): Promise<RepoSyncState | undefined> {
        const { records } = await this.execute(
            `SELECT sync_status, last_synced_at, file_count, chunk_count, error_message
             FROM repo_sync_state
             WHERE user_id = :userId AND repo_full_name = :repoFullName`,
            [
                { name: 'userId',       value: { stringValue: userId } },
                { name: 'repoFullName', value: { stringValue: repoFullName } },
            ],
        );

        if (!records || records.length === 0) return undefined;

        const row = records[0] as Field[];
        return {
            userId,
            repoFullName,
            syncStatus:   row[0].stringValue as SyncStatus,
            lastSyncedAt: row[1].stringValue ? new Date(row[1].stringValue) : undefined,
            fileCount:    row[2].longValue ?? 0,
            chunkCount:   row[3].longValue ?? 0,
            errorMessage: row[4].stringValue ?? undefined,
        };
    }

    // =========================================================================
    // ISyncStateRepository.upsert
    // =========================================================================

    async upsert(state: RepoSyncState): Promise<void> {
        await this.execute(
            `INSERT INTO repo_sync_state (
                user_id, repo_full_name, sync_status,
                last_synced_at, file_count, chunk_count, error_message
            ) VALUES (
                :userId, :repoFullName, :syncStatus,
                :lastSyncedAt, :fileCount, :chunkCount, :errorMessage
            )
            ON CONFLICT (user_id, repo_full_name)
            DO UPDATE SET
                sync_status    = EXCLUDED.sync_status,
                last_synced_at = EXCLUDED.last_synced_at,
                file_count     = EXCLUDED.file_count,
                chunk_count    = EXCLUDED.chunk_count,
                error_message  = EXCLUDED.error_message`,
            [
                { name: 'userId',       value: { stringValue: state.userId } },
                { name: 'repoFullName', value: { stringValue: state.repoFullName } },
                { name: 'syncStatus',   value: { stringValue: state.syncStatus } },
                { name: 'lastSyncedAt', value: state.lastSyncedAt
                    ? { stringValue: state.lastSyncedAt.toISOString() }
                    : { isNull: true } },
                { name: 'fileCount',    value: { longValue: state.fileCount } },
                { name: 'chunkCount',   value: { longValue: state.chunkCount } },
                { name: 'errorMessage', value: state.errorMessage
                    ? { stringValue: state.errorMessage }
                    : { isNull: true } },
            ],
        );
    }

    // =========================================================================
    // ISyncStateRepository shorthands
    // =========================================================================

    async markStarted(userId: string, repoFullName: string): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus: 'syncing',
            fileCount: 0,
            chunkCount: 0,
        });
    }

    async markComplete(
        userId: string,
        repoFullName: string,
        fileCount: number,
        chunkCount: number,
    ): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus: 'complete',
            lastSyncedAt: new Date(),
            fileCount,
            chunkCount,
        });
    }

    async markError(
        userId: string,
        repoFullName: string,
        errorMessage: string,
    ): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus: 'error',
            lastSyncedAt: new Date(),
            fileCount: 0,
            chunkCount: 0,
            errorMessage,
        });
    }

    // =========================================================================
    // Private — Data API wrapper
    // =========================================================================

    private async execute(sql: string, parameters: SqlParameter[] = []) {
        return this.client.send(new ExecuteStatementCommand({
            resourceArn: this.config.resourceArn,
            secretArn:   this.config.secretArn,
            database:    this.config.database,
            sql,
            parameters,
        }));
    }
}
