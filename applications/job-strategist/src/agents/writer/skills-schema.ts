/** @format */
import { z } from 'zod';
import { SkillCategoryBaseSchema } from '../../schemas/resume-sections.js';

export const SkillsAgentOutputSchema = z.object({ skills: z.array(SkillCategoryBaseSchema) });

export type SkillCategory = z.infer<typeof SkillCategoryBaseSchema>;
export type SkillsAgentOutput = z.infer<typeof SkillsAgentOutputSchema>;

// Forced-tool input schema for emit_skills (constrained decoding).
export const SKILLS_EMIT_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        skills: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    category: { type: 'string' },
                    skills: { type: 'array', items: { type: 'string' } },
                },
                required: ['category', 'skills'],
            },
        },
    },
    required: ['skills'],
} as const;
