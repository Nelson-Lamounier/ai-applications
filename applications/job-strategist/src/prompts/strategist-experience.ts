/**
 * @format
 * Strategist Experience Agent system prompt.
 *
 * CONTENT LIVES IN content/strategist/experience-agent.md -- edit the markdown
 * to change instructions; this module only loads it and preserves the
 * Bedrock cachePoint boundary. Version flows into prompt_invocations via
 * STRATEGIST_EXPERIENCE_META.
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { loadPersona, type PromptMeta } from './prompt-loader.js';

const loaded = loadPersona('strategist/experience-agent');

export const STRATEGIST_EXPERIENCE_META: PromptMeta = loaded.meta;
export const STRATEGIST_EXPERIENCE_SYSTEM_PROMPT: SystemContentBlock[] = loaded.blocks;
