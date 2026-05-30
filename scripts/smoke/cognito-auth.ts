/** @format */
/** Per-user Cognito JWT auth for the smoke harness. The IdToken's `sub` is
 *  the Cognito subject — NOT the platform `users.id` (that is a separate
 *  gen_random_uuid() resolved by email). No secret values are ever logged. */
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SmokeSetupError } from './types.js';

/** Decode one string claim from a JWT without verifying the signature. */
export function decodeJwtClaim(idToken: string, claim: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) {
    throw new SmokeSetupError('Cognito IdToken is not a well-formed JWT');
  }
  let claims: Record<string, unknown> | null;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    throw new SmokeSetupError('Cognito IdToken payload is not valid JSON');
  }
  const v = claims?.[claim];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Decode the `sub` claim (throws if absent). */
export function decodeJwtSub(idToken: string): string {
  const sub = decodeJwtClaim(idToken, 'sub');
  if (!sub) throw new SmokeSetupError('Cognito IdToken has no sub claim');
  return sub;
}

/** Mint an IdToken via Cognito USER_PASSWORD_AUTH. Returns the token, its
 *  `sub`, and the `email` claim (used to resolve the platform users.id). */
export async function mintCognitoJwt(o: {
  clientId: string;
  username: string;
  password: string;
  region: string;
}): Promise<{ idToken: string; sub: string; email?: string }> {
  const client = new CognitoIdentityProviderClient({ region: o.region });
  const res = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: o.clientId,
      AuthParameters: { USERNAME: o.username, PASSWORD: o.password },
    }),
  );
  const idToken = res.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new SmokeSetupError(
      'Cognito returned no IdToken (check SMOKE_COGNITO_USERNAME/PASSWORD)',
    );
  }
  return {
    idToken,
    sub: decodeJwtSub(idToken),
    email: decodeJwtClaim(idToken, 'email'),
  };
}
