/** @format */
import { z } from 'zod';

/** The summary agent emits four beats; the system assembles the string. */
export const SummaryBeatsSchema = z.object({
    s1: z.string().min(1),
    s2: z.string().min(1),
    s3: z.string().min(1),
    s4: z.string().min(1),
});

export type SummaryBeats = z.infer<typeof SummaryBeatsSchema>;

/** Bedrock forced-tool input schema (mirrors SummaryBeatsSchema; kept in sync by the test). */
export const SUMMARY_EMIT_INPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        s1: { type: 'string', description: 'Identity + years framing, aligned to the JD role class' },
        s2: { type: 'string', description: 'Problem bridge in candidate voice; never the company name' },
        s3: { type: 'string', description: 'Distinctive angle from Profile Intelligence / achievement evidence' },
        s4: { type: 'string', description: 'The close: rigor-as-shape (senior) or forward-fit (junior)' },
    },
    required: ['s1', 's2', 's3', 's4'],
    additionalProperties: false,
};

/** Join the four beats into the summary string the resume persists. */
export function assembleSummary(beats: SummaryBeats): string {
    return [beats.s1, beats.s2, beats.s3, beats.s4].join(' ');
}
