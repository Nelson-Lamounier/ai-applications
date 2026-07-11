/**
 * @format
 * Free-tier resume writer — system prompt.
 *
 * CONTENT LIVES IN content/free-resume-persona.md (frontmatter: id/version/
 * cachePoint) — edit the markdown to change instructions; this module only
 * loads it. It was the last pure-prose persona still inlined as a TS template
 * literal. Version flows into prompt_invocations via FREE_RESUME_PERSONA_META.
 *
 * The prompt is a single system block (no cache points): the free tier runs
 * one call per resume, so there is no cross-call prefix to cache.
 */
import { loadPrompt, type PromptMeta } from './prompt-loader.js';

const loaded = loadPrompt('free-resume-persona');

export const FREE_RESUME_PERSONA_META: PromptMeta = loaded.meta;
export const FREE_RESUME_SYSTEM_PROMPT: string = loaded.body;
