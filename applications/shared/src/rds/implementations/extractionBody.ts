/**
 * @format
 * Shared skill-extraction request body + output parser (feature 002). Lives in
 * its own module so BOTH the inline enricher (BedrockChunkEnricher) and the
 * batch helper (BedrockBatchEnrich) import it without a cycle — guaranteeing a
 * batched call is byte-identical to an inline one (the batch lever is cost-only).
 */

export const ENRICH_SYSTEM_PROMPT = [
    'You are a skill-evidence extractor for a resume-generation system.',
    'Given a single document chunk from a software repository, identify',
    'domain capabilities the chunk EVIDENCES the user has practised.',
    'Use short noun phrases (≤ 4 words). Examples:',
    '  "kubernetes networking", "iac with cdk", "step functions orchestration"',
    '',
    'Rules:',
    '  - Extract only signals that the chunk text actually demonstrates.',
    '    Do NOT infer from the file path, repository name, or chunk metadata.',
    '  - Generic prose ("we use kubernetes") with no specifics is awareness',
    '    only — STILL extract it. Do not gate on depth at this stage.',
    '  - Background facts about a technology (its limits, its history) are',
    '    NOT user signals. Skip them.',
    '  - Lowercased output. Deduplicate. Empty arrays are valid when no',
    '    signal is present.',
    '  - You MUST respond by calling the record_extraction tool. Do not write',
    '    free-form text.',
].join('\n');

export const ENRICH_TOOL_SCHEMA = {
    name:        'record_extraction',
    description: 'Records the extracted skills for the chunk.',
    input_schema: {
        type: 'object',
        properties: {
            skills: {
                type:        'array',
                items:       { type: 'string' },
                description: 'Domain capabilities the chunk evidences. Lowercased.',
            },
        },
        required: ['skills'],
        additionalProperties: false,
    },
};

/** The user-side prompt for one extraction unit (chunk or whole file). */
export function buildExtractionUserMessage(filePath: string, content: string, heading?: string): string {
    return [
        `File: ${filePath}`,
        `Section: ${heading ?? '(no heading)'}`,
        '',
        'Chunk content:',
        '"""',
        content,
        '"""',
    ].join('\n');
}

/** The Anthropic Messages body for one extraction (inline + batch share this). */
export function buildExtractionBody(filePath: string, content: string, heading?: string): Record<string, unknown> {
    return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        512,
        temperature:       0,
        system:            ENRICH_SYSTEM_PROMPT,
        tools:             [ENRICH_TOOL_SCHEMA],
        tool_choice:       { type: 'tool', name: 'record_extraction' },
        messages:          [{ role: 'user', content: buildExtractionUserMessage(filePath, content, heading) }],
    };
}

/** Pure: raw (un-canonicalised) skills from a record_extraction tool_use, or []. */
export function parseExtractionSkills(
    content: ReadonlyArray<{ type: string; name?: string; input?: { skills?: unknown[] } }>,
): unknown[] {
    const tu = content.find((b) => b.type === 'tool_use' && b.name === 'record_extraction');
    return tu?.input?.skills ?? [];
}

// =============================================================================
// Chunk-packing (feature 004): many chunks per call, skills keyed per chunk.
// =============================================================================

/** Per-chunk extraction tool — skills keyed by the chunk's stable id (not positional). */
export const ENRICH_PACK_TOOL_SCHEMA = {
    name:        'record_extractions',
    description: 'Records the extracted skills for EACH chunk, keyed by its id.',
    input_schema: {
        type: 'object',
        properties: {
            extractions: {
                type:  'array',
                items: {
                    type: 'object',
                    properties: {
                        key:    { type: 'string', description: 'The chunk id from its "=== CHUNK <id> ===" header.' },
                        skills: { type: 'array', items: { type: 'string' }, description: 'Domain capabilities the chunk evidences. Lowercased.' },
                    },
                    required: ['key', 'skills'],
                    additionalProperties: false,
                },
            },
        },
        required: ['extractions'],
        additionalProperties: false,
    },
};

export interface PackBodyItem { key: string; filePath: string; content: string; heading?: string }

/** User message: a shared instruction + one labelled block per chunk, keyed by id. */
function buildPackUserMessage(items: readonly PackBodyItem[]): string {
    const blocks = items.map((it) => [
        `=== CHUNK ${it.key} ===`,
        `File: ${it.filePath}`,
        `Section: ${it.heading ?? '(no heading)'}`,
        'Content:',
        '"""',
        it.content,
        '"""',
    ].join('\n'));
    return [
        `Extract skills for EACH of the ${items.length} chunks below.`,
        'Return exactly one entry per chunk via the record_extractions tool, keyed by the exact id in its "=== CHUNK <id> ===" header.',
        'Judge each chunk ONLY on its own content — do not let one chunk\'s skills bleed into another.',
        '',
        ...blocks,
    ].join('\n\n');
}

/**
 * The Anthropic Messages body for a PACK of chunks (feature 004): the SAME system
 * prompt as the per-chunk call, paid once, with N labelled chunks and a keyed
 * record_extractions tool. `max_tokens` scales with the pack size so every
 * chunk's skill list has room (a short response is caught + falls back).
 */
export function buildPackExtractionBody(items: readonly PackBodyItem[]): Record<string, unknown> {
    return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        Math.min(4000, 128 + items.length * 160),
        temperature:       0,
        system:            ENRICH_SYSTEM_PROMPT,
        tools:             [ENRICH_PACK_TOOL_SCHEMA],
        tool_choice:       { type: 'tool', name: 'record_extractions' },
        messages:          [{ role: 'user', content: buildPackUserMessage(items) }],
    };
}

/** Pure: key -> raw skills from a record_extractions tool_use. Missing keys absent
 *  (→ caller fallback), extras ignored, duplicate keys last-wins. Never positional. */
export function parsePackSkills(
    content: ReadonlyArray<{ type: string; name?: string; input?: { extractions?: unknown } }>,
): Map<string, unknown[]> {
    const out = new Map<string, unknown[]>();
    const tu = content.find((b) => b.type === 'tool_use' && b.name === 'record_extractions');
    const arr = tu?.input?.extractions;
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
        if (e && typeof (e as { key?: unknown }).key === 'string' && Array.isArray((e as { skills?: unknown }).skills)) {
            out.set((e as { key: string }).key, (e as { skills: unknown[] }).skills);
        }
    }
    return out;
}
