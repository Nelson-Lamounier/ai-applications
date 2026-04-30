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
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface ResumeProfile {
  name: string;
  title: string;
  email: string;
  location: string;
  linkedin?: string;
  github?: string;
  website?: string;
}

export interface ResumeExperience {
  company: string;
  title: string;
  period: string;
  highlights: string[];
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
          },
          required: ['company', 'title', 'period', 'highlights'],
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
        },
      },
    },
    required: ['profile', 'summary', 'experience', 'skills', 'education', 'certifications', 'projects', 'keyAchievements'],
  },
};

const MODEL_ID = process.env['EXTRACTION_MODEL_ID'] ?? 'anthropic.claude-haiku-4-5-20251001-v1:0';

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
  '- If the text is garbled, truncated, or appears to be an image-only PDF with no usable text, still call the tool with whatever data is recoverable.',
].join('\n');

export async function extractCareerData(
  resumeText: string,
  region: string,
): Promise<ExtractedCareerData> {
  const client = new BedrockRuntimeClient({ region });

  const safeText = resumeText.slice(0, MAX_RESUME_CHARS);

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'extract_career_data' },
    messages: [
      {
        role: 'user',
        content: `<resume>\n${safeText}\n</resume>`,
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body:        Buffer.from(JSON.stringify(requestBody)),
  });

  const response = await client.send(command);
  const parsed   = JSON.parse(Buffer.from(response.body).toString('utf-8'));

  // The forced tool_use response always has content[0] as tool_use block
  const toolUseBlock = parsed.content?.find(
    (block: { type: string }) => block.type === 'tool_use',
  );

  if (!toolUseBlock?.input) {
    throw new Error('extractCareerData: Bedrock returned no tool_use block');
  }

  return toolUseBlock.input as ExtractedCareerData;
}
