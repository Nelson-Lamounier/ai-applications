import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    log, emitEmfMetric, withSpan,
    InputSanitiser, OutputSanitiser,
    CHATBOT_SYSTEM_PROMPT, buildChatContext, recordZeroResultRetrieval,
    hydrateRdsEnv,
} from '@bedrock/shared';
import { getEnv } from './env.js';
import { multiQueryRetrieve } from './retrieval.js';
import { invokeClaude } from './invoke-claude.js';
import { validateSession, createSession, loadHistory, appendMessages } from './session.js';
import type { InvokeRequestBody, InvokeResponseBody, ErrorResponseBody, CallerRole } from './types.js';

// ─── Module-scoped singletons ─────────────────────────────────────────────────
const inputSanitiser  = new InputSanitiser();
const outputSanitiser = new OutputSanitiser();

let pool: Pool | undefined;
function getPool(): Pool {
    pool ??= new Pool({
        host:     process.env['RDS_HOST'],
        port:     Number(process.env['RDS_PORT'] ?? '5432'),
        database: process.env['RDS_DB_NAME'],
        user:     process.env['RDS_USER'],
        password: process.env['RDS_PASSWORD'],
        ssl:      false,
        max:      5,
    });
    return pool;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const UUID_REGEX     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LEN = 10_000;
const EMF_NAMESPACE  = 'BedrockChatbotAuthenticated';

const VALID_ROLES = new Set<CallerRole>(['recruiter', 'engineer', 'unknown']);

const CALLER_ROLE_SUFFIX: Record<CallerRole, string> = {
    recruiter: '\n\nCALLER CONTEXT: callerRole=recruiter. Lead with outcomes and business impact; keep technical depth light.',
    engineer:  '\n\nCALLER CONTEXT: callerRole=engineer. Prioritise architecture decisions, trade-offs, and implementation specifics.',
    unknown:   '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveOrigin(event: APIGatewayProxyEvent): string {
    const { allowedOrigins } = getEnv();
    const requestOrigin = event.headers?.origin ?? event.headers?.Origin;
    if (allowedOrigins === '*') return '*';
    const allowed = allowedOrigins.split(',').map(o => o.trim());
    if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
    return allowed[0] ?? '*';
}

function buildResponse(
    statusCode: number,
    body: InvokeResponseBody | ErrorResponseBody,
    origin: string,
): APIGatewayProxyResult {
    return {
        statusCode,
        headers: {
            'Content-Type':                 'application/json',
            'Access-Control-Allow-Origin':  origin,
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
        },
        body: JSON.stringify(body),
    };
}

function stripCodeFence(text: string): string {
    const match = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/);
    return match?.[1]?.trim() ?? text.trim();
}

type SessionResult =
    | { ok: true;  sessionId: string }
    | { ok: false; response: APIGatewayProxyResult };

async function resolveSession(
    db:          Pool,
    userId:      string,
    requestedId: string | undefined,
    origin:      string,
): Promise<SessionResult> {
    if (!requestedId) {
        return { ok: true, sessionId: await createSession(db, userId) };
    }
    if (!UUID_REGEX.test(requestedId)) {
        return { ok: false, response: buildResponse(400, { error: 'BadRequest', message: 'sessionId must be a valid UUID' }, origin) };
    }
    const exists = await validateSession(db, userId, requestedId);
    if (!exists) {
        return { ok: false, response: buildResponse(400, { error: 'BadRequest', message: 'Session not found' }, origin) };
    }
    return { ok: true, sessionId: requestedId };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = withSpan('chatbot-authenticated.handler', async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const origin    = resolveOrigin(event);
    const startTime = Date.now();

    try {
        // Resolve RDS host (SSM) + password (Secrets Manager) before any DB use,
        // so an endpoint rename or password rotation is picked up on cold start
        // without a redeploy. No-op if RDS_SSM_PREFIX / RDS_SECRET_NAME are unset.
        await hydrateRdsEnv();

        const env    = getEnv();
        const userId = env.portfolioOwnerUserId;

        // ── 1. Parse + validate ────────────────────────────────────────────────
        if (!event.body) {
            return buildResponse(400, { error: 'BadRequest', message: 'Request body is required' }, origin);
        }

        let parsed: InvokeRequestBody;
        try { parsed = JSON.parse(event.body) as InvokeRequestBody; }
        catch { return buildResponse(400, { error: 'BadRequest', message: 'Request body must be valid JSON' }, origin); }

        if (!parsed.prompt || typeof parsed.prompt !== 'string') {
            return buildResponse(400, { error: 'BadRequest', message: 'prompt is required and must be a string' }, origin);
        }
        if (parsed.prompt.length > MAX_PROMPT_LEN) {
            return buildResponse(400, { error: 'BadRequest', message: `prompt exceeds ${MAX_PROMPT_LEN} characters` }, origin);
        }

        // ── 2. Input sanitisation ──────────────────────────────────────────────
        const inputCheck = inputSanitiser.sanitise(parsed.prompt);
        if (inputCheck.blocked) {
            return buildResponse(200, {
                response:  'I can only help with questions about Nelson\'s portfolio projects, skills, and career experience. Could you rephrase your question?',
                sessionId: parsed.sessionId ?? '',
            }, origin);
        }

        // ── 3. Caller role ─────────────────────────────────────────────────────
        const rawRole = parsed.callerRole;
        const callerRole: CallerRole = rawRole !== undefined && VALID_ROLES.has(rawRole) ? rawRole : 'unknown';

        // ── 4. Session resolution ──────────────────────────────────────────────
        const db           = getPool();
        const sessionResult = await resolveSession(db, userId, parsed.sessionId, origin);
        if (!sessionResult.ok) return sessionResult.response;
        const { sessionId } = sessionResult;

        // ── 5. History + retrieval ─────────────────────────────────────────────
        const [history, passages] = await Promise.all([
            loadHistory(db, userId, sessionId),
            multiQueryRetrieve(userId, inputCheck.sanitised, db),
        ]);

        // ── 6. Build system prompt ─────────────────────────────────────────────
        if (passages.length === 0) {
            recordZeroResultRetrieval({
                namespace: EMF_NAMESPACE, appLabel: 'chatbot-authenticated',
                sessionId, prompt: parsed.prompt,
            });
        }
        const context      = buildChatContext(passages);
        const systemPrompt = CHATBOT_SYSTEM_PROMPT + CALLER_ROLE_SUFFIX[callerRole] + '\n\n' + context;

        // ── 7. Generate ────────────────────────────────────────────────────────
        const rawResponse = await invokeClaude(env.chatbotModel, systemPrompt, history, inputCheck.sanitised, {
            pool:   db,
            userId,
        });

        // ── 8. Output sanitisation ─────────────────────────────────────────────
        const normalised                       = stripCodeFence(rawResponse);
        const { sanitised: finalResponse, wasRedacted } = outputSanitiser.sanitiseWithReport(normalised);

        // ── 9. Persist + metrics ───────────────────────────────────────────────
        await appendMessages(db, userId, sessionId, inputCheck.sanitised, finalResponse);

        const durationMs = Date.now() - startTime;

        log('INFO', 'chatbot-authenticated invocation complete', {
            sessionId,
            promptHash:     createHash('sha256').update(parsed.prompt).digest('hex').slice(0, 16),
            durationMs,
            callerRole,
            outputRedacted: wasRedacted,
            historyLength:  history.length,
        });

        emitEmfMetric(EMF_NAMESPACE, { Environment: process.env['CDK_ENV'] ?? 'development' }, [
            { name: 'InvocationCount',   value: 1,          unit: 'Count' },
            { name: 'InvocationLatency', value: durationMs, unit: 'Milliseconds' },
        ], { sessionId });

        return buildResponse(200, { response: finalResponse, sessionId }, origin);

    } catch (err) {
        const durationMs   = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);
        log('ERROR', 'chatbot-authenticated error', { error: errorMessage, durationMs });
        emitEmfMetric(EMF_NAMESPACE, { Environment: process.env['CDK_ENV'] ?? 'development' }, [
            { name: 'InvocationErrors', value: 1, unit: 'Count' },
        ], {});
        return buildResponse(500, { error: 'InternalError', message: 'Failed to process request' }, origin);
    }
});
