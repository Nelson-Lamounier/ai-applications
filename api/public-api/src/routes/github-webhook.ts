// api/public-api/src/routes/github-webhook.ts
/**
 * @file github-webhook.ts
 * @description POST /webhooks/github
 *
 * Verifies the HMAC-SHA256 signature, then branches on installation
 * events. The body is read raw (arrayBuffer) because the HMAC is over
 * the exact wire bytes — any re-stringification breaks verification.
 *
 * Status-code contract: see
 * docs/superpowers/specs/2026-05-21-github-webhook-and-app-jwt-design.md.
 */

import { Hono } from 'hono';
import { verifyWebhookSignature, log } from '@bedrock/shared';
import { loadConfig } from '../lib/config.js';
import { getGitHubAppSecrets } from '../lib/githubAppSecrets.js';
import { getOAuthConnectionsRepo } from '../lib/oauth.js';

const githubWebhook = new Hono();

githubWebhook.post('/webhooks/github', async (c) => {
    const cfg        = loadConfig();
    const deliveryId = c.req.header('x-github-delivery') ?? 'unknown';
    const event      = c.req.header('x-github-event') ?? '';
    const sigHeader  = c.req.header('x-hub-signature-256');

    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const secrets = await getGitHubAppSecrets(cfg);

    if (!verifyWebhookSignature(rawBody, sigHeader, secrets.webhookSecret)) {
        log('WARN', 'github.webhook.invalid_signature', { deliveryId, event });
        return c.json({ error: 'invalid signature' }, 401);
    }

    if (event !== 'installation') {
        log('INFO', 'github.webhook.ignored', { deliveryId, event, reason: 'event_type' });
        return c.body(null, 204);
    }

    let payload: { action?: string; installation?: { id?: number | string } };
    try {
        payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
    } catch {
        log('WARN', 'github.webhook.bad_json', { deliveryId, event });
        return c.json({ error: 'bad json' }, 400);
    }

    const action = payload.action;
    const idRaw  = payload.installation?.id;
    const installationId = idRaw != null ? String(idRaw) : undefined;
    if (!installationId) {
        log('WARN', 'github.webhook.missing_installation_id', { deliveryId, event, action });
        return c.json({ error: 'missing installation.id' }, 400);
    }

    if (action !== 'deleted' && action !== 'suspended') {
        log('INFO', 'github.webhook.ignored', { deliveryId, event, action, reason: 'action_type' });
        return c.body(null, 204);
    }

    const repo = getOAuthConnectionsRepo(cfg);
    const row  = await repo.getByInstallationId(installationId);
    if (!row) {
        log('INFO', 'github.webhook.no_match', { deliveryId, event, action, installationId });
        return c.json({ status: 'no_match' }, 200);
    }

    const at = new Date();
    if (action === 'deleted') {
        await repo.markRevoked(row.id, at);
    } else {
        await repo.markSuspended(row.id, at);
    }

    log('INFO', 'github.webhook.processed', {
        deliveryId, event, action,
        installationId, oauthConnectionId: row.id,
    });
    return c.json({ status: 'ok' }, 200);
});

export default githubWebhook;
