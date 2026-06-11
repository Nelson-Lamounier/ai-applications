/** @format */
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const MODEL_ID = process.env['ROLE_CLASSIFIER_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface RoleClassification {
    familyKey: string;
    confidence: number;
    suggestedVocabulary: string[];
    suggestedTransferableSkills: string[];
}

const ResultSchema = z.object({
    familyKey:                   z.string(),
    confidence:                  z.number().min(0).max(1),
    suggestedVocabulary:         z.array(z.string()).max(12).default([]),
    suggestedTransferableSkills: z.array(z.string()).max(12).default([]),
});

const TOOL = {
    name: 'classify_role',
    description: 'Classify a job title into a known role family and suggest domain vocabulary.',
    input_schema: {
        type: 'object',
        properties: {
            familyKey:                   { type: 'string', description: 'One of the provided known family keys, or your best new kebab-case key if none fit.' },
            confidence:                  { type: 'number', minimum: 0, maximum: 1 },
            suggestedVocabulary:         { type: 'array', items: { type: 'string' }, description: 'Domain terms this role implies, derived from the title/highlights.' },
            suggestedTransferableSkills: { type: 'array', items: { type: 'string' }, description: 'Transferable skills this role implies.' },
        },
        required: ['familyKey', 'confidence', 'suggestedVocabulary', 'suggestedTransferableSkills'],
        additionalProperties: false,
    },
} as const;

const CTX: BasePipelineContext = { pipelineId: 'role-classify', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

/**
 * Classify a role title into one of `knownFamilies`. FAIL-OPEN: returns null on
 * any error, and null when the model's family is NOT in knownFamilies (caller
 * then falls back). The model reads the highlights, so per-user phrasing informs
 * the suggestions.
 */
export async function classifyRole(
    role: { title: string; company: string; highlights: string[] },
    knownFamilies: string[],
): Promise<RoleClassification | null> {
    const system = [
        'You classify a job title into a known role family. Call classify_role.',
        `Known families: ${knownFamilies.join(', ')}.`,
        '- Prefer a known family. Only invent a kebab-case key if none reasonably fit.',
        '- suggestedVocabulary/suggestedTransferableSkills: derive from the title + highlights provided; do not invent unrelated terms.',
    ].join('\n');
    const config: AgentConfig = {
        agentName: 'role-classifier', modelId: MODEL_ID, maxTokens: 512, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    const userMessage = `<role><title>${role.title}</title><company>${role.company}</company><highlights>${role.highlights.join(' | ')}</highlights></role>`;
    try {
        const result = await runAgent<RoleClassification>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const v = ResultSchema.safeParse(JSON.parse(s));
                if (!v.success) throw new Error(`role-classifier: schema validation failed: ${v.error.message}`);
                return v.data;
            },
        });
        if (!knownFamilies.includes(result.data.familyKey)) return null;
        return result.data;
    } catch (e) {
        log('WARN', 'role classification failed (non-fatal)', { agent: 'role-classifier', error: e instanceof Error ? e.message : String(e) });
        return null;
    }
}
