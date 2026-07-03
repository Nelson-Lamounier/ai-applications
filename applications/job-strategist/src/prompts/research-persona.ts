/**
 * @format
 * Research Agent System Prompt (matcher).
 *
 * CONTENT LIVES IN content/research-persona.md — edit the markdown to change
 * instructions; this module only loads it and preserves the Bedrock
 * cachePoint boundary. Version flows into prompt_invocations via
 * RESEARCH_PERSONA_META.
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { loadPersona, type PromptMeta } from './prompt-loader.js';

const loaded = loadPersona('research-persona');

export const RESEARCH_PERSONA_META: PromptMeta = loaded.meta;
export const RESEARCH_PERSONA_SYSTEM_PROMPT: SystemContentBlock[] = loaded.blocks;
