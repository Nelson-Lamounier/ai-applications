/**
 * @format
 * Runtime RDS credential hydration
 *
 * Resolves RDS_HOST from SSM and RDS_PASSWORD from Secrets Manager at Lambda
 * cold start and writes them onto process.env, so that a database endpoint
 * rename (e.g. a snapshot-restore migration) or a master-password rotation is
 * picked up on the next cold start WITHOUT a redeploy — and the plaintext
 * password is never baked into the function's environment at deploy time.
 *
 * Driven by two env vars set by the stack:
 *   RDS_SSM_PREFIX   e.g. /k8s/development/platform-rds  (host read from `${prefix}/host`)
 *   RDS_SECRET_NAME  e.g. k8s-development/platform-rds/credentials
 *
 * If neither is set this is a no-op, preserving backwards compatibility with
 * callers that still inject RDS_HOST / RDS_PASSWORD statically.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let inflight: Promise<void> | undefined;

async function resolve(): Promise<void> {
    const region     = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
    const ssmPrefix  = process.env['RDS_SSM_PREFIX'];
    const secretName = process.env['RDS_SECRET_NAME'];

    if (ssmPrefix) {
        const ssm = new SSMClient({ region });
        const { Parameter } = await ssm.send(new GetParameterCommand({ Name: `${ssmPrefix}/host` }));
        if (Parameter?.Value) process.env['RDS_HOST'] = Parameter.Value;
    }

    if (secretName) {
        const sm = new SecretsManagerClient({ region });
        const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
        if (SecretString) {
            const creds = JSON.parse(SecretString) as { password?: string; username?: string };
            if (creds.password) process.env['RDS_PASSWORD'] = creds.password;
            if (creds.username && !process.env['RDS_USER']) process.env['RDS_USER'] = creds.username;
        }
    }
}

/**
 * Idempotent, cached across warm invocations. Await this before opening any
 * pg pool. The AWS calls run once per container (cold start); warm invocations
 * resolve the memoised promise instantly.
 */
export function hydrateRdsEnv(): Promise<void> {
    inflight ??= resolve();
    return inflight;
}
