/**
 * @format
 * IOAuthConnectionsRepository — contract for oauth_connections persistence.
 *
 * Implementations are responsible for envelope-encrypting the access token
 * at rest (KMS-wrapped DEK + AES-256-GCM) so callers never see ciphertext
 * and can never accidentally skip encryption. The plaintext `accessToken`
 * lives only in process memory on the way in and out of the repo.
 *
 * Encryption context bound to `{ user_id, provider }` so a row's DEK cannot
 * be replayed against a different row's ciphertext.
 */

export interface OAuthConnection {
    id:             string;
    userId:         string;
    provider:       string;
    providerUserId: string;
    username:       string;
    accessToken:    string;          // plaintext, in-memory only
    scopes:         string[];
    installationId: string | null;
    connectedAt:    Date;
    revokedAt:      Date | null;
    suspendedAt:    Date | null;
}

export type NewOAuthConnection = Omit<
    OAuthConnection,
    'id' | 'connectedAt' | 'revokedAt' | 'suspendedAt'
>;

export interface IOAuthConnectionsRepository {
    upsert(c: NewOAuthConnection): Promise<OAuthConnection>;
    getByUserAndProvider(userId: string, provider: string): Promise<OAuthConnection | null>;
    getByInstallationId(installationId: string): Promise<OAuthConnection | null>;
    markRevoked(id: string, at: Date): Promise<void>;
    markSuspended(id: string, at: Date): Promise<void>;
    /**
     * Plain SQL lookup for `installation_id` — no envelope decryption.
     * Used by consumers that need the installation reference without
     * touching the encrypted access token (e.g. ingestion jobs).
     */
    getInstallationIdByUserAndProvider(userId: string, provider: string): Promise<string | null>;
}
