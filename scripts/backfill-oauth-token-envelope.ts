/**
 * CLI wrapper for the oauth_connections envelope-encryption backfill.
 *
 * The library function `runBackfill` (and its tests) live at
 * applications/shared/src/rds/backfillOAuthTokenEnvelope.ts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   OAUTH_TOKEN_KMS_KEY_ARN=arn:aws:kms:... \
 *   npx tsx scripts/backfill-oauth-token-envelope.ts
 */

import { Pool } from 'pg';
import { KMSClient } from '@aws-sdk/client-kms';
import { createKmsEnvelope } from '../applications/shared/src/crypto/index.js';
import { runBackfill } from '../applications/shared/src/rds/backfillOAuthTokenEnvelope.js';

async function main(): Promise<void> {
    const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'];
    if (!url) {
        console.error('DATABASE_URL or TEST_DATABASE_URL required');
        process.exit(2);
    }
    const keyId = process.env['OAUTH_TOKEN_KMS_KEY_ARN'];
    if (!keyId) {
        console.error('OAUTH_TOKEN_KMS_KEY_ARN required');
        process.exit(2);
    }

    const pool = new Pool({ connectionString: url });
    const envelope = createKmsEnvelope({ kmsClient: new KMSClient({}), keyId });

    try {
        const r = await runBackfill({ pool, envelope, batchSize: 100 });
        console.log(`backfill complete: ${r.encrypted} rows in ${r.batches} batches`);
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('backfill failed:', err);
    process.exit(1);
});
