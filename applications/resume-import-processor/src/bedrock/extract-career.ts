/**
 * @format
 * Bedrock structured career extraction — Phase 1 of the import pipeline.
 *
 * Calls Claude via InvokeModelCommand with forced tool_use to extract
 * the resume text into StructuredResumeData format. Uses the same
 * tool_use pattern as BedrockChunkEnricher in @bedrock/shared.
 *
 * Returns the structured data for immediate persistence.
 * Enrichment (Tavily research per role) runs separately in a second pass.
 */
import { z } from 'zod';
import { PiiScrubber, runAgent } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

const piiScrubber = new PiiScrubber();

/**
 * Typed failure for the career-extraction call. Fail-fast: a malformed model
 * response must never be cast and persisted (structure-output-checklist §7).
 */
export class CareerExtractionError extends Error {
  constructor(
    public readonly code: 'no_tool_use_block' | 'schema_validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CareerExtractionError';
  }
}

export interface ResumeProfile {
  name: string;
  title: string;
  email: string;
  location: string;
  linkedin?: string;
  github?: string;
  website?: string;
}

/**
 * Per-field confidence flags emitted by the extraction model.
 * Empty array = model is confident in every field of this experience entry.
 * Multiple flags allowed when several fields are uncertain.
 */
export type ExperienceConfidenceFlag =
  | 'dateRangeAmbiguous'  // e.g. "2019-Present" with no end date or unclear start
  | 'companyUnclear'      // OCR garbled, abbreviation, or missing company name
  | 'titleInferred'       // title not explicit, inferred from highlights
  | 'highlightsTruncated' // bullet list visibly cut off in source text
  | 'periodOverlap';      // overlaps another role; possible parsing error

export interface ResumeExperience {
  company: string;
  title: string;
  period: string;
  highlights: string[];
  /** Low-confidence field flags. Empty array when the model is confident. */
  confidenceFlags: ExperienceConfidenceFlag[];
}

export interface ResumeSkillCategory {
  category: string;
  skills: string[];
}

export interface ResumeEducation {
  degree: string;
  institution: string;
  period: string;
}

export interface ResumeCertification {
  name: string;
  year: string;
  issuer: string;
}

export interface ResumeProject {
  name: string;
  description: string;
  github?: string;
}

export interface ResumeAchievement {
  achievement: string;
}

export interface ExtractedCareerData {
  profile: ResumeProfile;
  summary: string;
  experience: ResumeExperience[];
  skills: ResumeSkillCategory[];
  education: ResumeEducation[];
  certifications: ResumeCertification[];
  projects: ResumeProject[];
  keyAchievements: ResumeAchievement[];
}

export interface CareerExtractionResult {
  data:         ExtractedCareerData;
  inputTokens:  number;
  outputTokens: number;
}

/**
 * Runtime safety-net mirror of {@link ExtractedCareerData}. `.strict()` on
 * every object is the Zod twin of JSON-Schema `additionalProperties:false` —
 * it rejects any field the model invents outside the contract.
 */
const ExtractedCareerDataSchema = z.object({
  profile: z.object({
    name:     z.string(),
    title:    z.string(),
    email:    z.string(),
    location: z.string(),
    linkedin: z.string().optional(),
    github:   z.string().optional(),
    website:  z.string().optional(),
  }).strict(),
  summary: z.string(),
  experience: z.array(z.object({
    company:    z.string(),
    title:      z.string(),
    period:     z.string(),
    highlights: z.array(z.string()),
    confidenceFlags: z.array(z.enum([
      'dateRangeAmbiguous',
      'companyUnclear',
      'titleInferred',
      'highlightsTruncated',
      'periodOverlap',
    ])),
  }).strict()),
  skills: z.array(z.object({
    category: z.string(),
    skills:   z.array(z.string()),
  }).strict()),
  education: z.array(z.object({
    degree:      z.string(),
    institution: z.string(),
    period:      z.string(),
  }).strict()),
  certifications: z.array(z.object({
    name:   z.string(),
    year:   z.string(),
    issuer: z.string(),
  }).strict()),
  projects: z.array(z.object({
    name:        z.string(),
    description: z.string(),
    github:      z.string().optional(),
  }).strict()),
  keyAchievements: z.array(z.object({
    achievement: z.string(),
  }).strict()),
}).strict();

const EXTRACTION_TOOL_SCHEMA = {
  name: 'extract_career_data',
  description: 'Extract structured career data from resume text',
  input_schema: {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          title:    { type: 'string', description: 'Current or most recent job title' },
          email:    { type: 'string' },
          location: { type: 'string' },
          linkedin: { type: 'string' },
          github:   { type: 'string' },
          website:  { type: 'string' },
        },
        required: ['name', 'title', 'email', 'location'],
        additionalProperties: false,
      },
      summary: { type: 'string', description: 'Professional summary or objective' },
      experience: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            company:    { type: 'string' },
            title:      { type: 'string' },
            period:     { type: 'string', description: 'e.g. "Jan 2021 – Mar 2023"' },
            highlights: { type: 'array', items: { type: 'string' } },
            confidenceFlags: {
              type:        'array',
              description: 'Flags for low-confidence fields. Empty array when confident.',
              items: {
                type: 'string',
                enum: [
                  'dateRangeAmbiguous',
                  'companyUnclear',
                  'titleInferred',
                  'highlightsTruncated',
                  'periodOverlap',
                ],
              },
            },
          },
          required: ['company', 'title', 'period', 'highlights', 'confidenceFlags'],
          additionalProperties: false,
        },
      },
      skills: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            skills:   { type: 'array', items: { type: 'string' } },
          },
          required: ['category', 'skills'],
          additionalProperties: false,
        },
      },
      education: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            degree:      { type: 'string' },
            institution: { type: 'string' },
            period:      { type: 'string' },
          },
          required: ['degree', 'institution', 'period'],
          additionalProperties: false,
        },
      },
      certifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:   { type: 'string' },
            year:   { type: 'string' },
            issuer: { type: 'string' },
          },
          required: ['name', 'year', 'issuer'],
          additionalProperties: false,
        },
      },
      projects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:        { type: 'string' },
            description: { type: 'string' },
            github:      { type: 'string' },
          },
          required: ['name', 'description'],
          additionalProperties: false,
        },
      },
      keyAchievements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            achievement: { type: 'string' },
          },
          required: ['achievement'],
          additionalProperties: false,
        },
      },
    },
    required: ['profile', 'summary', 'experience', 'skills', 'education', 'certifications', 'projects', 'keyAchievements'],
    additionalProperties: false,
  },
};

const MODEL_ID = process.env['EXTRACTION_MODEL_ID'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

// Cap resume text size before sending to Bedrock — prevents token explosion on
// malformed/verbose PDFs. Typical resume is <8k chars; 40k covers edge cases.
const MAX_RESUME_CHARS = 40_000;

const SYSTEM_PROMPT = [
  'You are a resume data extractor. Your only task is to call the extract_career_data tool.',
  'Rules:',
  '- Extract exactly what is written. Do not invent, infer, or embellish any field.',
  '- If a field is absent from the resume, use an empty string or empty array — never guess.',
  '- Dates: preserve the original format (e.g. "Jan 2021 – Mar 2023", "2019–Present").',
  '- Highlights: each bullet point from the experience section becomes one array item.',
  '- Skills: group by category if the resume groups them; otherwise use a single "Technical Skills" category.',
  '- For every experience entry, set confidenceFlags: include flags only when you are genuinely unsure about that specific field. Use an empty array when all fields are clearly readable. Available flags: dateRangeAmbiguous, companyUnclear, titleInferred, highlightsTruncated, periodOverlap. Do not invent flags outside this list.',
  '- If the text is garbled, truncated, or appears to be an image-only PDF with no usable text, still call the tool with whatever data is recoverable.',
].join('\n');

export async function extractCareerData(
  resumeText: string,
  _region: string,
): Promise<CareerExtractionResult> {
  const safeText = piiScrubber.scrub(resumeText).redacted.slice(0, MAX_RESUME_CHARS);

  // Consolidated onto the shared runAgent() wrapper (Converse + forced tool_use
  // + structured extraction). Cost stays caller-tracked: run-import.ts records
  // it from the returned token counts, so no onInvocationComplete sink here.
  const config: AgentConfig = {
    agentName:      'resume-extract',
    modelId:        MODEL_ID,
    maxTokens:      4096,
    thinkingBudget: 0,
    systemPrompt:   [{ text: SYSTEM_PROMPT }],
    pipeline:       'resume-import',
    tool: { name: EXTRACTION_TOOL_SCHEMA.name, description: EXTRACTION_TOOL_SCHEMA.description, inputSchema: EXTRACTION_TOOL_SCHEMA.input_schema as Record<string, unknown> },
  };
  const ctx: BasePipelineContext = {
    pipelineId:        'resume-extract',
    environment:       process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
  };

  const { bedrockDurationSeconds } = await import('../metrics.js');
  const stop = bedrockDurationSeconds().startTimer({ purpose: 'extract' });
  try {
    const result = await runAgent<ExtractedCareerData>({
      config,
      userMessage:     `<resume>\n${safeText}\n</resume>`,
      pipelineContext: ctx,
      parseResponse: (s) => {
        const v = ExtractedCareerDataSchema.safeParse(JSON.parse(s));
        if (!v.success) {
          throw new CareerExtractionError(
            'schema_validation_failed',
            `extractCareerData: schema validation failed: ${v.error.message}`,
          );
        }
        return v.data as ExtractedCareerData;
      },
    });
    return {
      data:         result.data,
      inputTokens:  result.tokenUsage.inputTokens,
      outputTokens: result.tokenUsage.outputTokens,
    };
  } catch (err) {
    if (err instanceof CareerExtractionError) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof CareerExtractionError) throw cause;
    // runAgent throws when the forced tool produced no tool_use (refusal) or
    // on a Bedrock error — map onto the existing error code.
    throw new CareerExtractionError('no_tool_use_block', err instanceof Error ? err.message : String(err));
  } finally {
    stop();
  }
}
