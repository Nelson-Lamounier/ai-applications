/** @format */
import { jest } from '@jest/globals';
const send = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send })),
  InitiateAuthCommand: jest.fn((i: unknown) => ({ i })),
}));
import { decodeJwtSub, decodeJwtClaim, mintCognitoJwt } from '../cognito-auth';

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

describe('decodeJwtSub', () => {
  it('extracts the sub claim', () => {
    expect(decodeJwtSub(jwt({ sub: '31f4686a-979b-4765-a17c-22a1e71cec59' })))
      .toBe('31f4686a-979b-4765-a17c-22a1e71cec59');
  });
  it('throws on a token with no sub', () => {
    expect(() => decodeJwtSub(jwt({ email: 'x' }))).toThrow(/sub/i);
  });
});

describe('decodeJwtClaim', () => {
  it('returns the claim when present, undefined when absent', () => {
    expect(decodeJwtClaim(jwt({ email: 'dev@example.com' }), 'email')).toBe('dev@example.com');
    expect(decodeJwtClaim(jwt({ sub: 's' }), 'email')).toBeUndefined();
  });
});

describe('mintCognitoJwt', () => {
  beforeEach(() => send.mockReset());
  it('returns idToken + sub from USER_PASSWORD_AUTH', async () => {
    const idToken = jwt({ sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', email: 'dev@example.com' });
    (send as jest.Mock).mockResolvedValueOnce({ AuthenticationResult: { IdToken: idToken } });
    const r = await mintCognitoJwt({ clientId: 'cid', username: 'u', password: 'p', region: 'eu-west-1' });
    expect(r).toEqual({ idToken, sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', email: 'dev@example.com' });
  });
  it('throws SmokeSetupError when Cognito returns no IdToken', async () => {
    (send as jest.Mock).mockResolvedValueOnce({});
    await expect(mintCognitoJwt({ clientId: 'cid', username: 'u', password: 'p', region: 'eu-west-1' }))
      .rejects.toThrow(/cognito|idtoken/i);
  });
});
