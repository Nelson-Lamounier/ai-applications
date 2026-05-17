/** @format */
/** Per-user Cognito JWT auth for the smoke harness. The IdToken's `sub`
 *  claim IS the RDS user_id (UUID). No secret values are ever logged. */
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SmokeSetupError } from './types.js';

/** Decode the `sub` claim from a JWT without verifying the signature. */
export function decodeJwtSub(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length < 2) {
    throw new SmokeSetupError('Cognito IdToken is not a well-formed JWT (no sub)');
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    throw new SmokeSetupError('Cognito IdToken payload is not valid JSON (no sub)');
  }
  const sub = (claims as { sub?: unknown } | null)?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new SmokeSetupError('Cognito IdToken has no sub claim');
  }
  return sub;
}

/** Mint an IdToken via Cognito USER_PASSWORD_AUTH and return it plus its sub. */
export async function mintCognitoJwt(o: {
  clientId: string;
  username: string;
  password: string;
  region: string;
}): Promise<{ idToken: string; sub: string }> {
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
  return { idToken, sub: decodeJwtSub(idToken) };
}
