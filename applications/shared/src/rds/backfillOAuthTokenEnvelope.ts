/**
 * @format
 * One-shot backfill: encrypts plaintext oauth_connections.access_token_enc
 * rows into the envelope columns added by migration 027.
 *
 * Idempotent (WHERE-guard on access_token_ciphertext IS NULL) and batched.
 * Re-runnable. Halts non-zero on first row error.
 *
 * The library function `runBackfill` is unit-tested with a fake pg Pool
 * and fake envelope. A thin CLI wrapper lives at
 * `scripts/backfill-oauth-token-envelope.ts`.
 */

import type { Pool } from 'pg';
import type { KmsEnvelope } from '../crypto/index.js';

export interface BackfillResult {
    encrypted: number;
    batches:   number;
}

interface PlaintextRow {
    id:               string;
    user_id:          string;
    provider:         string;
    access_token_enc: string;
}

export async function runBackfill(opts: {
    pool:      Pool;
    envelope:  KmsEnvelope;
    batchSize: number;
}): Promise<BackfillResult> {
    const { pool, envelope, batchSize } = opts;
    let encrypted = 0;
    let batches = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const sel = await pool.query<PlaintextRow>(
            `SELECT id, user_id, provider, access_token_enc
             FROM oauth_connections
             WHERE access_token_ciphertext IS NULL
               AND access_token_enc IS NOT NULL
             ORDER BY id
             LIMIT $1`,
            [batchSize],
        );

        if (sel.rows.length === 0) break;

        const client = await pool.connect();
        let batchCount = 0;
        try {
            await client.query('BEGIN');
            for (const r of sel.rows) {
                const p = await envelope.encrypt(r.access_token_enc, {
                    user_id:  r.user_id,
                    provider: r.provider,
                });
                await client.query(
                    `UPDATE oauth_connections SET
                        access_token_ciphertext = $2,
                        access_token_dek        = $3,
                        access_token_iv         = $4,
                        access_token_tag        = $5
                     WHERE id = $1
                       AND access_token_ciphertext IS NULL`,
                    [r.id, p.ciphertext, p.dek, p.iv, p.tag],
                );
                batchCount++;
            }
            await client.query('COMMIT');
            // Only count rows whose UPDATE survived the COMMIT.
            encrypted += batchCount;
            batches++;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    return { encrypted, batches };
}
