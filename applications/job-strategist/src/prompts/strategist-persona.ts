/**
 * @format
 * Strategist Agent System Prompt, 5-Phase Analysis Engine
 *
 * CONTENT LIVES IN content/strategist-persona.md (frontmatter: id/version/
 * cachePoint) — edit the markdown to change instructions; this module only
 * loads it and preserves the Bedrock cachePoint block boundary. Version
 * flows into prompt_invocations via STRATEGIST_PERSONA_META.
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { loadPersona, type PromptMeta } from './prompt-loader.js';

const loaded = loadPersona('strategist-persona');

export const STRATEGIST_PERSONA_META: PromptMeta = loaded.meta;
export const STRATEGIST_PERSONA_SYSTEM_PROMPT: SystemContentBlock[] = loaded.blocks;
