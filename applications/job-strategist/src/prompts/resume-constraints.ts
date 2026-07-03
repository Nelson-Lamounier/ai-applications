/**
 * @format
 * Resume Constraints — the five former wiki-mcp constraint pages
 * (agent-guide, gap-awareness, voice-library, role-archetypes, achievements).
 *
 * CONTENT LIVES IN content/constraints/<page>.md, one file per page — the
 * "mirrored from agent-guide.md" era of double-maintenance ends here: edit
 * the page, and every consumer (research injection, strategist forwarding)
 * gets the same text. This module concatenates the pages in their canonical
 * order, byte-identical to the previous inlined constant.
 */
import { loadPrompt } from './prompt-loader.js';

const PAGE_ORDER = ['agent-guide', 'gap-awareness', 'voice-library', 'role-archetypes', 'achievements'] as const;

export const RESUME_CONSTRAINTS: string = PAGE_ORDER
    .map((page) => `\n${loadPrompt(`constraints/${page}`).body}`)
    .join('');
