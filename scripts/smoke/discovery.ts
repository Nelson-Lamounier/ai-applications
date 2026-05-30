/** @format */
import { getSSMParameter, resolveAuth } from '@repo/script-utils/aws.js';
import type { AwsConfig } from '@repo/script-utils/aws.js';
import { capture } from './exec-wrapper.js';
import { COGNITO } from './admin-api-contract.js';
import { SmokeSetupError } from './types.js';

export function decodeK8sSecret(b64: string): string {
  return Buffer.from(b64.trim(), 'base64').toString('utf-8');
}

async function k8sSecret(ns: string, name: string, key: string): Promise<string> {
  const b64 = await capture('kubectl', [
    '-n', ns, 'get', 'secret', name, '-o', `jsonpath={.data.${key}}`,
  ]);
  if (!b64) throw new SmokeSetupError(`secret ${ns}/${name} key "${key}" empty/not found`);
  return decodeK8sSecret(b64);
}

/** SSM/AWS config the orchestrator resolves once and threads through.
 *  `credentials` MUST be forwarded — getSSMParameter authenticates via
 *  config.credentials, NOT config.profile; dropping it makes every SSM
 *  call fall back to an empty default chain and fail closed as
 *  "not found". */
type SsmCfg = Pick<AwsConfig, 'region' | 'profile' | 'credentials'>;

async function ssmRequired(name: string, cfg: SsmCfg): Promise<string> {
  // getSSMParameter returns string | undefined; treat a missing param as a
  // setup error so callers never operate on undefined endpoints.
  const value = await getSSMParameter(name, {
    region: cfg.region,
    profile: cfg.profile,
    credentials: cfg.credentials,
    environment: 'dev',
  });
  if (!value) throw new SmokeSetupError(`SSM parameter "${name}" not found or empty`);
  return value;
}

/**
 * All three chatbot URLs share a single API base (SSM `/<prefix>/api-url`);
 * they differ only by path (/invoke, /invoke-public, /invoke-authenticated),
 * which the suites append. We return the stripped base for all three.
 */
export async function resolveChatbotUrls(
  namePrefix: string,
  cfg: SsmCfg,
): Promise<{ chatbotUrl: string; chatbotPublicUrl: string; chatbotAuthenticatedUrl: string }> {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const base = strip(await ssmRequired(`/${namePrefix}/api-url`, cfg));
  return { chatbotUrl: base, chatbotPublicUrl: base, chatbotAuthenticatedUrl: base };
}

/** Optional SecureString agent API key; absent → null (auth is optional). */
export async function resolveChatbotApiKey(
  namePrefix: string,
  cfg: SsmCfg,
): Promise<string | null> {
  try {
    const v = await getSSMParameter(`/${namePrefix}/agent-api-key`, {
      region: cfg.region,
      profile: cfg.profile,
      credentials: cfg.credentials,
      environment: 'dev',
    });
    return v || null;
  } catch {
    return null;
  }
}

/** Cognito app client id: explicit override else the live k8s secret. */
export async function resolveCognitoClientId(): Promise<string> {
  if (COGNITO.clientIdOverride) return COGNITO.clientIdOverride;
  return k8sSecret(COGNITO.secretNamespace, COGNITO.secretName, COGNITO.clientIdKey);
}

/** RDS connection bits from the platform k8s secret (host/port stay local). */
export async function resolveRdsConn(): Promise<{
  database: string;
  user: string;
  password: string;
}> {
  const [database, user, password] = await Promise.all([
    k8sSecret('platform', 'platform-rds-credentials', 'PG_DATABASE'),
    k8sSecret('platform', 'platform-rds-credentials', 'PG_USER'),
    k8sSecret('platform', 'platform-rds-credentials', 'PG_PASSWORD'),
  ]);
  return { database, user, password };
}

export async function resolvePgPassword(): Promise<string> {
  return (await resolveRdsConn()).password;
}

export { resolveAuth };
