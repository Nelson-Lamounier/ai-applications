// api/public-api/src/routes/internal-revoke-github.ts
/**
 * @file internal-revoke-github.ts
 * @description POST /internal/revoke-github
 *
 * Called by tucaken-app's admin-api when a user soft-deletes their account.
 * Looks up the user's GitHub oauth_connections row, signs a GitHub App JWT,
 * calls DELETE /app/installations/{id}, and marks the row revoked.
 *
 * Auth: shared Bearer token. The token lives alongside the App private key
 * inside a single Secrets Manager JSON secret — see getGitHubAppSecrets().
 *
 * Status-code contract: see
 * docs/superpowers/specs/2026-05-21-internal-github-app-revoke-design.md.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { signGitHubAppJwt, revokeInstallation, log } from '@bedrock/shared';
import { loadConfig } from '../lib/config.js';
import { getGitHubAppSecrets } from '../lib/githubAppSecrets-wrapper.js';
import { getOAuthConnectionsRepo } from '../lib/oauth.js';

const internalRevoke = new Hono();

function verifyBearer(authHeader: string | undefined, expected: string): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authHeader.slice('Bearer '.length), 'utf8');
    const wanted   = Buffer.from(expected, 'utf8');
    if (supplied.length !== wanted.length) return false;
    return timingSafeEqual(supplied, wanted);
}

internalRevoke.post('/internal/revoke-github', async (c) => {
    const cfg     = loadConfig();
    const secrets = await getGitHubAppSecrets(cfg);

    if (!verifyBearer(c.req.header('authorization'), secrets.internalApiToken)) {
        log('WARN', 'internal.revoke_github.unauthorized', { ip: c.req.header('x-forwarded-for') });
        return c.json({ error: 'unauthorized' }, 401);
    }

    let body: { userId?: string; reason?: string };
    try {
        body = await c.req.json();
    } catch {
        log('WARN', 'internal.revoke_github.bad_json', {});
        return c.json({ error: 'bad json' }, 400);
    }

    const userId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : undefined;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined;
    if (!userId) {
        log('WARN', 'internal.revoke_github.missing_userId', {});
        return c.json({ error: 'missing userId' }, 400);
    }

    const repo = getOAuthConnectionsRepo(cfg);
    const row  = await repo.getByUserAndProvider(userId, 'github');
    if (!row) {
        log('INFO', 'internal.revoke_github.no_match', { userId, reason });
        return c.json({ status: 'no_match' }, 200);
    }

    if (!row.installationId) {
        await repo.markRevoked(row.id, new Date());
        log('INFO', 'internal.revoke_github.no_installation', {
            userId, reason, oauthConnectionId: row.id,
        });
        return c.json({ status: 'no_installation' }, 200);
    }

    const jwt = signGitHubAppJwt({
        appId:         secrets.appId,
        privateKeyPem: secrets.privateKeyPem,
    });
    const result = await revokeInstallation({ installationId: row.installationId, jwt });

    if (!result.ok) {
        log('ERROR', 'internal.revoke_github.github_error', {
            userId, reason, oauthConnectionId: row.id,
            installationId: row.installationId,
            githubStatus:   result.status,
            githubBody:     result.body,
        });
        return c.json({ error: 'github error', status: result.status }, 500);
    }

    await repo.markRevoked(row.id, new Date());

    log('INFO', 'internal.revoke_github.processed', {
        userId, reason, oauthConnectionId: row.id,
        installationId: row.installationId,
        alreadyDeleted: result.alreadyDeleted,
    });
    return c.json({ status: 'ok', alreadyDeleted: result.alreadyDeleted }, 200);
});

export default internalRevoke;
