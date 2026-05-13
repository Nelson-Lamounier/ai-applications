import {
    BedrockRuntimeClient,
    ConverseCommand,
    type Message,
} from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({});

export async function invokeClaude(
    modelId:      string,
    systemPrompt: string,
    history:      Message[],
    userText:     string,
): Promise<string> {
    const command = new ConverseCommand({
        modelId,
        system:   [{ text: systemPrompt }],
        messages: [...history, { role: 'user', content: [{ text: userText }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
    });

    const response = await bedrockClient.send(command);
    const block    = response.output?.message?.content?.[0];

    if (!block || !('text' in block) || typeof block.text !== 'string') {
        throw new Error('Unexpected response shape from Bedrock Converse');
    }

    return block.text;
}
