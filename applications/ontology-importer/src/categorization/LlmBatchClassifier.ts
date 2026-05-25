/** @format */
import Anthropic from '@anthropic-ai/sdk';
import type { RawImportEntry, OntologyCategory, CategorizationResult } from '@bedrock/shared';
import { ONTOLOGY_CATEGORIES } from '@bedrock/shared';

export const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM: Anthropic.Messages.TextBlockParam[] = [
    {
        type: 'text',
        text:
            'You categorize software packages for a developer-resume system. ' +
            'Decide if a package is technology-worthy (yes/no/maybe) and pick exactly one category.',
        cache_control: { type: 'ephemeral' },
    },
];

/** Loosely typed: the SDK `Tool.InputSchema` does not model an enum that mixes
 *  strings with `null`, so we build the runtime shape and cast to the SDK type.
 *  The runtime shape is what the API consumes; the cast keeps the build clean. */
const TOOL = {
    name: 'classify_package',
    description: 'Record the classification decision for a package.',
    input_schema: {
        type: 'object' as const,
        properties: {
            decision: { type: 'string', enum: ['yes', 'no', 'maybe'] },
            category: { type: ['string', 'null'], enum: [...ONTOLOGY_CATEGORIES, null] },
            reasoning: { type: 'string', maxLength: 200 },
        },
        required: ['decision', 'category', 'reasoning'],
        additionalProperties: false,
    },
    cache_control: { type: 'ephemeral' as const },
} as unknown as Anthropic.Messages.Tool;

export interface BatchRequest {
    custom_id: string;
    params: Anthropic.Messages.MessageCreateParamsNonStreaming;
}

/** Pure: map raw entries to Message Batches API requests (one per entry). */
export function buildBatchRequests(entries: RawImportEntry[], ecosystem: string): BatchRequest[] {
    return entries.map((e) => ({
        custom_id: `${ecosystem}:${e.source_identifier}`.slice(0, 64),
        params: {
            model: MODEL,
            max_tokens: 256,
            system: SYSTEM,
            tools: [TOOL],
            tool_choice: { type: 'tool', name: 'classify_package' },
            messages: [
                {
                    role: 'user',
                    content:
                        `Package: ${e.source_identifier}\n` +
                        `Ecosystem: ${ecosystem}\n` +
                        `Description: ${e.description ?? '(none)'}\n` +
                        `Keywords: ${(e.keywords ?? []).join(', ') || '(none)'}`,
                },
            ],
        },
    }));
}

/** Pure: extract the `classify_package` tool_use input from a batch message. */
export function parseBatchResult(
    _customId: string,
    message: { content?: Array<{ type: string; name?: string; input?: unknown }> },
): Pick<CategorizationResult, 'decision' | 'category' | 'reasoning'> {
    const tu = (message.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'classify_package');
    if (!tu?.input) return { decision: 'maybe', category: null, reasoning: 'no tool_use' };
    const i = tu.input as { decision?: string; category?: string | null; reasoning?: string };
    return {
        decision: (i.decision as 'yes' | 'no' | 'maybe') ?? 'maybe',
        category: (i.category as OntologyCategory | null) ?? null,
        reasoning: i.reasoning,
    };
}

/** Thin SDK shell (mocked in tests; pure functions above carry the logic). */
export class LlmBatchClassifier {
    private readonly client: Anthropic;

    constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
        this.client = new Anthropic({ apiKey });
    }

    async submit(requests: BatchRequest[]): Promise<string> {
        const batch = await this.client.messages.batches.create({ requests });
        return batch.id;
    }

    async retrieve(batchId: string): Promise<Anthropic.Messages.MessageBatch> {
        return this.client.messages.batches.retrieve(batchId);
    }

    results(batchId: string): ReturnType<Anthropic['messages']['batches']['results']> {
        return this.client.messages.batches.results(batchId);
    }
}
