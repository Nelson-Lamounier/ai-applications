/** @format */
import { getSSMParameter, resolveAuth } from '@repo/script-utils/aws.js';
import { capture } from './exec-wrapper.js';
import { ADMIN_API, CHATBOT_AUTH } from './admin-api-contract.js';
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

async function ssmRequired(
  name: string,
  cfg: { region: string; profile?: string },
): Promise<string> {
  // getSSMParameter returns string | undefined; treat a missing param as a
  // setup error so callers never operate on undefined endpoints.
  const value = await getSSMParameter(name, {
    region: cfg.region,
    profile: cfg.profile,
    environment: 'dev',
  });
  if (!value) throw new SmokeSetupError(`SSM parameter "${name}" not found or empty`);
  return value;
}

export async function resolveChatbotUrls(
  namePrefix: string,
  cfg: { region: string; profile?: string },
): Promise<{ chatbotUrl: string; chatbotPublicUrl: string; chatbotAuthenticatedUrl: string }> {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const [u, p, a] = await Promise.all([
    ssmRequired(`/${namePrefix}/api-url`, cfg),
    ssmRequired(`/${namePrefix}/chatbot-public-api-url`, cfg),
    ssmRequired(`/${namePrefix}/chatbot-authenticated-api-url`, cfg),
  ]);
  return { chatbotUrl: strip(u), chatbotPublicUrl: strip(p), chatbotAuthenticatedUrl: strip(a) };
}

export async function resolveAdminSecrets(): Promise<{ adminApiToken: string; chatbotAuthJwt: string | null }> {
  const adminApiToken = await k8sSecret('admin-api', ADMIN_API.tokenSecretName, ADMIN_API.tokenSecretKey);
  let chatbotAuthJwt: string | null = null;
  try { chatbotAuthJwt = await k8sSecret('admin-api', CHATBOT_AUTH.jwtSecretName, CHATBOT_AUTH.jwtSecretKey); }
  catch { chatbotAuthJwt = null; }
  return { adminApiToken, chatbotAuthJwt };
}

export async function resolvePgPassword(): Promise<string> {
  return k8sSecret('platform', 'platform-rds-credentials',
    process.env.SMOKE_PG_SECRET_KEY ?? 'password');
}

export { resolveAuth };
