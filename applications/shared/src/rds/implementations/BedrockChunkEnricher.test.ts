import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSend = jest.fn<() => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invokeModelCommand = jest.fn<(args: any) => any>((args) => ({ args }));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    InvokeModelCommand:   invokeModelCommand,
}));

import { BedrockChunkEnricher } from './BedrockChunkEnricher.js';
import type { RawChunk } from '../types.js';

function chunk(): RawChunk {
    return {
        filePath: 'README.md',
        heading:  'Overview',
        content:  'We deploy with Kubernetes and Calico.',
    } as RawChunk;
}

function bedrockReply(toolInput: object) {
    return {
        body: Buffer.from(JSON.stringify({
            usage:   { input_tokens: 10, output_tokens: 5 },
            content: [{ type: 'tool_use', name: 'record_extraction', input: toolInput }],
        })),
    };
}

describe('BedrockChunkEnricher', () => {
    beforeEach(() => {
        mockSend.mockReset();
        invokeModelCommand.mockClear();
    });

    it('sends a tool schema with additionalProperties:false (no invented fields)', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({ skills: [], technologies: [] }));
        await new BedrockChunkEnricher().enrich(chunk());

        const sentBody = JSON.parse(
            Buffer.from(invokeModelCommand.mock.calls[0]?.[0].body).toString('utf-8'),
        );
        expect(sentBody.tools[0].input_schema.additionalProperties).toBe(false);
    });

    it('normalises arrays and ignores any extra field the model emits', async () => {
        mockSend.mockResolvedValueOnce(bedrockReply({
            skills:       ['Kubernetes Networking', 'kubernetes networking'],
            technologies: ['Calico'],
            injected:     'nope',
        }));

        const result = await new BedrockChunkEnricher().enrich(chunk());

        expect(result.skills).toEqual(['kubernetes networking']);
        expect(result.technologies).toEqual(['calico']);
        expect(result).not.toHaveProperty('injected');
    });
});
