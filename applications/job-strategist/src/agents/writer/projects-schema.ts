/** @format */
import { z } from 'zod';

const CuratedHighlightSchema = z.object({ bulletId: z.string().min(1) }).strict();
const ComposedHighlightSchema = z.object({
  text: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
}).strict();
export const ProjectsAgentHighlightSchema = z.union([CuratedHighlightSchema, ComposedHighlightSchema]);
export const ProjectsAgentEntrySchema = z.object({
  name: z.string(),
  github: z.string().catch(''),
  description: z.string(),
  highlights: z.array(ProjectsAgentHighlightSchema),
});
export const ProjectsAgentOutputSchema = z.object({ entries: z.array(ProjectsAgentEntrySchema) });

export type ProjectsAgentHighlight = z.infer<typeof ProjectsAgentHighlightSchema>;
export type ProjectsAgentEntry = z.infer<typeof ProjectsAgentEntrySchema>;
export type ProjectsAgentOutput = z.infer<typeof ProjectsAgentOutputSchema>;

export function isCurated(h: ProjectsAgentHighlight): h is { bulletId: string } {
  return 'bulletId' in h;
}

// Forced-tool input schema for emit_projects (constrained decoding).
export const PROJECTS_EMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, github: { type: 'string' }, description: { type: 'string' },
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                bulletId: { type: 'string' },
                text: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        required: ['name', 'description', 'highlights'],
      },
    },
  },
  required: ['entries'],
} as const;
