/**
 * @format
 * RdsOAuthConnectionsRepository — IOAuthConnectionsRepository backed by RDS.
 *
 * Owns all reads/writes of oauth_connections. Encryption happens here so
 * callers never see ciphertext and can never accidentally skip encryption.
 * Encryption context is bound to `{ user_id, provider }` so a row's DEK
 * cannot be replayed against a different row's ciphertext.
 *
 * Transition window (between migrations 027 and 028): reads prefer
 * envelope columns; if absent, fall back to plaintext access_token_enc.
 * Writes only populate envelope columns. Remove fallback after 028.
 */

import type { Pool } from 'pg';
import type {
    IOAuthConnectionsRepository,
    NewOAuthConnection,
    OAuthConnection,
} from '../interfaces/IOAuthConnectionsRepository.js';
import type { KmsEnvelope } from '../../crypto/index.js';

interface Row {
    id:                       string;
    user_id:                  string;
    provider:                 string;
    provider_user_id:         string;
    username:                 string;
    access_token_enc:         string | null;
    access_token_ciphertext:  Buffer | null;
    access_token_dek:         Buffer | null;
    access_token_iv:          Buffer | null;
    access_token_tag:         Buffer | null;
    scopes:                   string[] | null;
    installation_id:          string | null;
    connected_at:             Date;
    revoked_at:               Date | null;
    suspended_at:             Date | null;
}

export class RdsOAuthConnectionsRepository implements IOAuthConnectionsRepository {
    constructor(
        private readonly deps: {
            pool:     Pool;
            envelope: KmsEnvelope;
        },
    ) {}

    async upsert(c: NewOAuthConnection): Promise<OAuthConnection> {
        const payload = await this.deps.envelope.encrypt(c.accessToken, {
            user_id:  c.userId,
            provider: c.provider,
        });

        const sql = `
            INSERT INTO oauth_connections (
                user_id, provider, provider_user_id, username,
                access_token_ciphertext, access_token_dek, access_token_iv, access_token_tag,
                scopes, installation_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (user_id, provider) DO UPDATE SET
                provider_user_id        = EXCLUDED.provider_user_id,
                username                = EXCLUDED.username,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                access_token_dek        = EXCLUDED.access_token_dek,
                access_token_iv         = EXCLUDED.access_token_iv,
                access_token_tag        = EXCLUDED.access_token_tag,
                scopes                  = EXCLUDED.scopes,
                installation_id         = EXCLUDED.installation_id,
                revoked_at              = NULL,
                suspended_at            = NULL
            RETURNING *
        `;
        const res = await this.deps.pool.query<Row>(sql, [
            c.userId,
            c.provider,
            c.providerUserId,
            c.username,
            payload.ciphertext,
            payload.dek,
            payload.iv,
            payload.tag,
            c.scopes,
            c.installationId,
        ]);
        return this.toModel(res.rows[0]!, c.accessToken);
    }

    async getByUserAndProvider(userId: string, provider: string): Promise<OAuthConnection | null> {
        const res = await this.deps.pool.query<Row>(
            `SELECT * FROM oauth_connections WHERE user_id = $1 AND provider = $2`,
            [userId, provider],
        );
        const row = res.rows[0];
        if (!row) return null;
        const plaintext = await this.decryptRow(row);
        return this.toModel(row, plaintext);
    }

    async getByInstallationId(installationId: string): Promise<OAuthConnection | null> {
        const res = await this.deps.pool.query<Row>(
            `SELECT * FROM oauth_connections WHERE installation_id = $1`,
            [installationId],
        );
        const row = res.rows[0];
        if (!row) return null;
        const plaintext = await this.decryptRow(row);
        return this.toModel(row, plaintext);
    }

    async markRevoked(id: string, at: Date): Promise<void> {
        await this.deps.pool.query(
            `UPDATE oauth_connections SET revoked_at = $2 WHERE id = $1`,
            [id, at],
        );
    }

    async markSuspended(id: string, at: Date): Promise<void> {
        await this.deps.pool.query(
            `UPDATE oauth_connections SET suspended_at = $2 WHERE id = $1`,
            [id, at],
        );
    }

    // TODO(PR-2): add `oauth.token.encrypt` / `oauth.token.decrypt` structured
    // logs and an `OAuthTokenDecryptFailures` CloudWatch metric (spec
    // Observability section). Wiring lands with the public-api boot-site work.
    //
    // Transition-window dual-read: prefer envelope columns, fall back to
    // plaintext. Remove the fallback branch after migration 030 (sql/manual).
    private async decryptRow(row: Row): Promise<string> {
        if (
            row.access_token_ciphertext &&
            row.access_token_dek &&
            row.access_token_iv &&
            row.access_token_tag
        ) {
            return this.deps.envelope.decrypt(
                {
                    ciphertext: row.access_token_ciphertext,
                    dek:        row.access_token_dek,
                    iv:         row.access_token_iv,
                    tag:        row.access_token_tag,
                },
                { user_id: row.user_id, provider: row.provider },
            );
        }
        if (row.access_token_enc != null) return row.access_token_enc; // TODO remove after 028
        throw new Error(`oauth_connections row ${row.id} has no token material`);
    }

    private toModel(row: Row, plaintext: string): OAuthConnection {
        return {
            id:             row.id,
            userId:         row.user_id,
            provider:       row.provider,
            providerUserId: row.provider_user_id,
            username:       row.username,
            accessToken:    plaintext,
            scopes:         row.scopes ?? [],
            installationId: row.installation_id,
            connectedAt:    row.connected_at,
            revokedAt:      row.revoked_at,
            suspendedAt:    row.suspended_at,
        };
    }
}
