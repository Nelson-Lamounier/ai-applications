/**
 * @format
 * Cover letter schema.
 *
 * Relocated from agents/writer/strategist-agent.ts ahead of the writer's
 * deletion (Phase 5 PR-B) -- this schema is a load-bearing survivor consumed
 * outside the writer (free-resume-writer.ts).
 */
import { z } from 'zod';

export const CoverLetterSchema = z.object({
    greeting:   z.string(),
    paragraphs: z.array(z.string()),
    signoff:    z.object({ name: z.string(), email: z.string(), linkedin: z.string(), github: z.string() }),
});

export type { CoverLetter } from '@bedrock/shared';
