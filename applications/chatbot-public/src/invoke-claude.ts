import {
    BedrockRuntimeClient,
    ConverseCommand,
    type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBedrockCost, captureAwsClient } from '@bedrock/shared';
import type { Pool } from 'pg';

const bedrockClient = captureAwsClient(new BedrockRuntimeClient({}));

/** Per-call context for booking spend into prompt_invocations. Optional so the
 *  function stays usable in tests without a DB. The public chatbot attributes
 *  cost to the portfolio owner whose bot is being queried. */
export interface ChatbotCostContext {
    pool:   Pool;
    userId: string;
}

export async function invokeClaude(
    modelId:      string,
    systemPrompt: string,
    history:      Message[],
    userText:     string,
    costCtx?:     ChatbotCostContext,
): Promise<string> {
    const command = new ConverseCommand({
        modelId,
        system:   [{ text: systemPrompt }],
        messages: [...history, { role: 'user', content: [{ text: userText }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
    });

    const response = await bedrockClient.send(command);

    if (costCtx) {
        recordBedrockCost(costCtx.pool, {
            userId:       costCtx.userId,
            modelId,
            pipeline:     'chatbot-public',
            inputTokens:  response.usage?.inputTokens  ?? 0,
            outputTokens: response.usage?.outputTokens ?? 0,
        }).catch((err) => console.warn('[chatbot-public] cost record failed (non-fatal)', err));
    }

    const block = response.output?.message?.content?.[0];

    if (!block || !('text' in block) || typeof block.text !== 'string') {
        throw new Error('Unexpected response shape from Bedrock Converse');
    }

    return block.text;
}
