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

/** Normalise-then-validate output: `output` feeds ProjectsAgentOutputSchema.parse
 *  next; `normalisedExtras` counts every item/field this pass stripped (0 when
 *  nothing needed stripping, including malformed/non-object `raw`). */
export interface NormalisedProjectsOutput { readonly output: unknown; readonly normalisedExtras: number; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `record`'s own keys are exactly `expected`, no more, no fewer --
 *  the "nothing left to strip" check shared by both highlight shapes. */
function isExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((k) => k in record);
}

/** Normalise a single highlight item per the locked bulletId-authoritative
 *  rule: a non-empty `bulletId` wins outright (curated) regardless of what
 *  else is present -- the id is authoritative because the final text is
 *  assembled from the pool, so a tampered echo can never reach the resume.
 *  Only without a `bulletId` does a `text` + non-empty `sources` pair count
 *  as composed. Anything matching neither shape is returned unchanged so
 *  ProjectsAgentOutputSchema still rejects it -- a hard failure is preserved
 *  for genuinely malformed items. */
function normaliseHighlight(highlight: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(highlight)) return { value: highlight, changed: false };

  const bulletId = highlight['bulletId'];
  if (typeof bulletId === 'string' && bulletId.length > 0) {
    const isClean = isExactKeys(highlight, ['bulletId']);
    return isClean ? { value: highlight, changed: false } : { value: { bulletId }, changed: true };
  }

  const text = highlight['text'];
  const sources = highlight['sources'];
  if (typeof text === 'string' && Array.isArray(sources) && sources.length > 0) {
    const isClean = isExactKeys(highlight, ['text', 'sources']);
    return isClean ? { value: highlight, changed: false } : { value: { text, sources }, changed: true };
  }

  return { value: highlight, changed: false };
}

/** Normalise one entry: discard an agent-emitted `description` (a later
 *  pipeline stage stamps it from the stored project pitch -- amended
 *  decision C4) and run every highlight through `normaliseHighlight`. */
function normaliseEntry(entry: unknown): { value: unknown; extras: number } {
  if (!isRecord(entry)) return { value: entry, extras: 0 };

  let extras = 0;
  const nextEntry: Record<string, unknown> = { ...entry };

  if (typeof nextEntry['description'] === 'string' && nextEntry['description'].length > 0) {
    nextEntry['description'] = '';
    extras += 1;
  }

  if (Array.isArray(nextEntry['highlights'])) {
    nextEntry['highlights'] = nextEntry['highlights'].map((highlight: unknown) => {
      const normalised = normaliseHighlight(highlight);
      if (normalised.changed) extras += 1;
      return normalised.value;
    });
  }

  return { value: nextEntry, extras };
}

/**
 * Normalise-then-validate schema tolerance for the projects agent's forced-tool
 * output, run immediately before ProjectsAgentOutputSchema.parse. The wire
 * schema (PROJECTS_EMIT_INPUT_SCHEMA) allows bulletId/text/sources as flat
 * sibling properties on one highlight item, but the strict runtime union
 * (CuratedHighlightSchema.strict() | ComposedHighlightSchema.strict()) only
 * accepts ONE of the two legal shapes -- the model keeps volunteering sources
 * alongside a bulletId (this pipeline's own provenance culture), and the whole
 * paid-for generation was being zod-rejected and discarded every run. This
 * function tolerates that specific, known-safe over-emission while leaving
 * every other malformed shape a hard failure (zod still rejects it downstream).
 *
 * Malformed or non-object `raw` (or a missing/non-array `entries`) is returned
 * unchanged with `normalisedExtras: 0` -- there is nothing safe to normalise.
 */
export function normaliseProjectsAgentOutput(raw: unknown): NormalisedProjectsOutput {
  if (!isRecord(raw)) return { output: raw, normalisedExtras: 0 };
  const entriesRaw = raw['entries'];
  if (!Array.isArray(entriesRaw)) return { output: raw, normalisedExtras: 0 };

  let normalisedExtras = 0;
  const entries = entriesRaw.map((entry: unknown) => {
    const normalised = normaliseEntry(entry);
    normalisedExtras += normalised.extras;
    return normalised.value;
  });

  return { output: { ...raw, entries }, normalisedExtras };
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
          name: { type: 'string' }, github: { type: 'string' },
          description: {
            type: 'string',
            description: 'System-authored -- the pipeline stamps this from the stored project pitch after generation. Any value written here is discarded.',
          },
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              description: 'Curated = bulletId ONLY -- no text, no sources. Composed = text + sources ONLY -- no bulletId. Do not combine the two shapes.',
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
