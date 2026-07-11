/**
 * @format
 * Strategist Summary Agent system prompt.
 *
 * CONTENT LIVES IN content/strategist/summary.md — edit the markdown to
 * change instructions; this module only loads it and preserves the Bedrock
 * cachePoint boundary. Version flows into prompt_invocations via
 * STRATEGIST_SUMMARY_META.
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { loadPersona, type PromptMeta } from './prompt-loader.js';

const loaded = loadPersona('strategist/summary');

export const STRATEGIST_SUMMARY_META: PromptMeta = loaded.meta;
export const STRATEGIST_SUMMARY_SYSTEM_PROMPT: SystemContentBlock[] = loaded.blocks;
