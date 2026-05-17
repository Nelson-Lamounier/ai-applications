/**
 * @format
 * Phase 7 — zero-result retrieval observability.
 *
 * Shared by every chatbot handler that performs its own retrieval so the
 * WARN log + ZeroResultRetrieval metric stay identical across apps.
 */

import { createHash } from 'node:crypto';

import { log } from '../logger.js';
import { emitEmfMetric } from '../emf.js';

export interface ZeroResultRetrievalParams {
    /** CloudWatch namespace of the calling app (e.g. 'BedrockChatbotPublic'). */
    readonly namespace: string;
    /** Human label for the log line (e.g. 'chatbot-public'). */
    readonly appLabel: string;
    /** Session id for correlation. */
    readonly sessionId: string;
    /** Raw user prompt — hashed, never logged in clear. */
    readonly prompt: string;
}

/**
 * Log and meter a zero-result retrieval event. The system prompt forces an
 * honest "I don't have that information" answer when retrieved context is
 * empty; this records the event for monitoring and dataset improvement.
 */
export function recordZeroResultRetrieval(params: ZeroResultRetrievalParams): void {
    const { namespace, appLabel, sessionId, prompt } = params;

    log('WARN', `${appLabel} zero-result retrieval`, {
        sessionId,
        promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    });

    emitEmfMetric(
        namespace,
        { Environment: process.env['CDK_ENV'] ?? 'development' },
        [{ name: 'ZeroResultRetrieval', value: 1, unit: 'Count' }],
        { sessionId },
    );
}
