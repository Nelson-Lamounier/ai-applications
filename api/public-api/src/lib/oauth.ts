/**
 * @file oauth.ts
 * @description Lazy singletons for the OAuth-connection KMS envelope and
 * repository. Mirrors lib/pg.ts:getPool — first call constructs the
 * underlying client and caches it at module scope; subsequent calls reuse
 * the cached instance. Routes that need to read/write oauth_connections
 * call getOAuthConnectionsRepo(loadConfig()).
 *
 * The KMSClient is constructed once with the region from Config; the
 * default credential provider chain resolves AWS credentials from the
 * EC2 node instance profile (see config.ts header).
 */

import { KMSClient } from '@aws-sdk/client-kms';
import {
    createKmsEnvelope,
    RdsOAuthConnectionsRepository,
    type KmsEnvelope,
    type IOAuthConnectionsRepository,
} from '@bedrock/shared';
import { getPool } from './pg.js';
import type { Config } from './config.js';

let kmsClient: KMSClient | undefined;
let envelope:  KmsEnvelope | undefined;
let repo:      IOAuthConnectionsRepository | undefined;

export function getKmsEnvelope(config: Config): KmsEnvelope {
    if (!envelope) {
        kmsClient = new KMSClient({ region: config.awsRegion });
        envelope  = createKmsEnvelope({
            kmsClient,
            keyId: config.oauthTokenKmsKeyArn,
        });
    }
    return envelope;
}

export function getOAuthConnectionsRepo(config: Config): IOAuthConnectionsRepository {
    if (!repo) {
        repo = new RdsOAuthConnectionsRepository({
            pool:     getPool(config),
            envelope: getKmsEnvelope(config),
        });
    }
    return repo;
}

/** Test seam — resets all singletons. Use only in tests. */
export function __resetOAuthSingletonsForTests(): void {
    kmsClient = undefined;
    envelope  = undefined;
    repo      = undefined;
}
