import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
    log, emitEmfMetric, withSpan,
    InputSanitiser, OutputSanitiser,
    CHATBOT_SYSTEM_PROMPT, buildChatContext,
} from '@bedrock/shared';
import { getEnv } from './env.js';
import { multiQueryRetrieve } from './retrieval.js';
import { invokeClaude } from './invoke-claude.js';
import type { InvokeRequestBody, InvokeResponseBody, ErrorResponseBody, CallerRole } from './types.js';

// ─── Feature flag ──────────────────────────────────────────────────────────────
const CHATBOT_RETRIEVAL_SOURCE = (): string =>
    process.env['CHATBOT_RETRIEVAL_SOURCE'] ?? 'bedrock-agent';

// ─── Module-scoped singletons ─────────────────────────────────────────────────
const inputSanitiser  = new InputSanitiser();
const outputSanitiser = new OutputSanitiser();
const agentClient     = new BedrockAgentRuntimeClient({});

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
const EMF_NAMESPACE  = 'BedrockChatbotPublic';

const CALLER_ROLE_SUFFIX: Record<CallerRole, string> = {
    recruiter: '\n\nCALLER CONTEXT: callerRole=recruiter. Lead with outcomes and business impact; keep technical depth light.',
    engineer:  '\n\nCALLER CONTEXT: callerRole=engineer. Prioritise architecture decisions, trade-offs, and implementation specifics.',
    unknown:   '',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = withSpan('chatbot-public.handler', async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const origin    = resolveOrigin(event);
    const startTime = Date.now();

    try {
        const env = getEnv();

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

        if (parsed.sessionId && !UUID_REGEX.test(parsed.sessionId)) {
            return buildResponse(400, { error: 'BadRequest', message: 'sessionId must be a valid UUID' }, origin);
        }
        const sessionId = parsed.sessionId ?? randomUUID();

        const inputCheck = inputSanitiser.sanitise(parsed.prompt);
        if (inputCheck.blocked) {
            return buildResponse(200, {
                response: 'I can only help with questions about Nelson\'s portfolio projects, skills, and career experience. Could you rephrase your question?',
                sessionId,
            }, origin);
        }

        const validRoles: CallerRole[] = ['recruiter', 'engineer', 'unknown'];
        const callerRole: CallerRole   = validRoles.includes(parsed.callerRole as CallerRole)
            ? parsed.callerRole as CallerRole
            : 'unknown';

        let rawResponse: string;

        if (CHATBOT_RETRIEVAL_SOURCE() === 'rds-pgvector') {
            const passages     = await multiQueryRetrieve(env.portfolioOwnerUserId, inputCheck.sanitised, getPool());
            const context      = buildChatContext(passages);
            const systemPrompt = CHATBOT_SYSTEM_PROMPT + CALLER_ROLE_SUFFIX[callerRole] + '\n\n' + context;
            rawResponse        = await invokeClaude(env.chatbotModel, systemPrompt, [], inputCheck.sanitised);
        } else {
            const agentCmd = new InvokeAgentCommand({
                agentId:      env.agentId,
                agentAliasId: env.agentAliasId,
                sessionId,
                inputText:    inputCheck.sanitised,
                sessionState: { promptSessionAttributes: { callerRole } },
            });
            const agentResp = await agentClient.send(agentCmd);
            if (!agentResp.completion) throw new Error('No completion stream from Bedrock Agent');
            const chunks: string[] = [];
            for await (const ev of agentResp.completion) {
                if ('chunk' in ev && ev.chunk?.bytes) {
                    chunks.push(new TextDecoder('utf-8').decode(ev.chunk.bytes));
                }
            }
            rawResponse = chunks.join('');
        }

        const normalised = stripCodeFence(rawResponse);
        const { sanitised: sanitisedResponse, wasRedacted } = outputSanitiser.sanitiseWithReport(normalised);
        const durationMs = Date.now() - startTime;

        log('INFO', 'chatbot-public invocation complete', {
            sessionId,
            promptHash:      createHash('sha256').update(parsed.prompt).digest('hex').slice(0, 16),
            durationMs,
            retrievalSource: CHATBOT_RETRIEVAL_SOURCE(),
            callerRole,
            outputRedacted:  wasRedacted,
        });

        emitEmfMetric(EMF_NAMESPACE, { Environment: process.env['CDK_ENV'] ?? 'development' }, [
            { name: 'InvocationCount',   value: 1,          unit: 'Count' },
            { name: 'InvocationLatency', value: durationMs, unit: 'Milliseconds' },
        ], { sessionId });

        return buildResponse(200, { response: sanitisedResponse, sessionId }, origin);

    } catch (err) {
        const durationMs   = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);
        log('ERROR', 'chatbot-public error', { error: errorMessage, durationMs });
        emitEmfMetric(EMF_NAMESPACE, { Environment: process.env['CDK_ENV'] ?? 'development' }, [
            { name: 'InvocationErrors', value: 1, unit: 'Count' },
        ], {});
        return buildResponse(500, { error: 'InternalError', message: 'Failed to process request' }, origin);
    }
});
