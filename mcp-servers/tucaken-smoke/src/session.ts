/** @format */
import type { Endpoints, CleanupTarget } from '../../../scripts/smoke/lib/index.js';

export interface SmokeSession {
  endpoints?: Endpoints;
  idToken?: string;
  /** Cognito subject claim — NOT the platform users.id (see testUserId). */
  cognitoSub?: string;
  /** Email used to resolve the platform users.id (Cognito email claim or username). */
  email?: string;
  /** Platform users.id (gen_random_uuid). Starts unresolved after smoke_auth
   *  and is lazily filled on the first DB connection. */
  testUserId?: string;
  /** True once testUserId holds the resolved platform users.id (not the sub). */
  platformUserIdResolved?: boolean;
  cleanup: CleanupTarget[];
  tunnelStop?: () => void;
  /** Stop fn for the admin-api port-forward (svc/admin-api:3002 → 13002),
   *  opened once per session by ensureAdminApiTunnel(). */
  adminApiTunnelStop?: () => void;
}
export const session: SmokeSession = { cleanup: [] };
export function requireAuth(): { endpoints: Endpoints; idToken: string; testUserId: string } {
  if (!session.endpoints || !session.idToken || !session.testUserId) throw new Error('call smoke_auth first');
  return { endpoints: session.endpoints, idToken: session.idToken, testUserId: session.testUserId };
}
