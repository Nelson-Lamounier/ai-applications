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
