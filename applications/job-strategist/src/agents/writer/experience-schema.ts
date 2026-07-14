/** @format */
import { z } from 'zod';

export const ExperienceAgentBulletSchema = z.object({
  text: z.string().min(1),
  sources: z.array(z.string()),
  atsTargets: z.array(z.string()).catch([]),
});
export const ExperienceAgentRoleSchema = z.object({
  company: z.string(),
  title: z.string(),
  period: z.string(),
  highlights: z.array(ExperienceAgentBulletSchema),
});
export const ExperienceAgentOutputSchema = z.object({
  roles: z.array(ExperienceAgentRoleSchema),
  accounting: z.object({
    dropped: z.array(z.object({ line: z.string(), reason: z.string() })).catch([]),
  }).catch({ dropped: [] }),
});
export type ExperienceAgentBullet = z.infer<typeof ExperienceAgentBulletSchema>;
export type ExperienceAgentRole = z.infer<typeof ExperienceAgentRoleSchema>;
export type ExperienceAgentOutput = z.infer<typeof ExperienceAgentOutputSchema>;

/** Forced-tool input schema (constrained decoding) for emit_experience. */
export const EXPERIENCE_EMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' }, title: { type: 'string' }, period: { type: 'string' },
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
                atsTargets: { type: 'array', items: { type: 'string' } },
              },
              required: ['text', 'sources'],
            },
          },
        },
        required: ['company', 'title', 'period', 'highlights'],
      },
    },
    accounting: {
      type: 'object',
      properties: {
        dropped: {
          type: 'array',
          items: {
            type: 'object',
            properties: { line: { type: 'string' }, reason: { type: 'string' } },
            required: ['line', 'reason'],
          },
        },
      },
      required: ['dropped'],
    },
  },
  required: ['roles', 'accounting'],
} as const;
