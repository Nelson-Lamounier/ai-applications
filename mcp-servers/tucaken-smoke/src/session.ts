/** @format */
import type { Endpoints, CleanupTarget } from '../../../scripts/smoke/lib/index.js';

export interface SmokeSession {
  endpoints?: Endpoints;
  idToken?: string;
  testUserId?: string;
  cleanup: CleanupTarget[];
  tunnelStop?: () => void;
}
export const session: SmokeSession = { cleanup: [] };
export function requireAuth(): { endpoints: Endpoints; idToken: string; testUserId: string } {
  if (!session.endpoints || !session.idToken || !session.testUserId) throw new Error('call smoke_auth first');
  return { endpoints: session.endpoints, idToken: session.idToken, testUserId: session.testUserId };
}
