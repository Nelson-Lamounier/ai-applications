/**
 * @format
 * Strategist Agent System Prompt, 5-Phase Analysis Engine
 *
 * CONTENT LIVES IN content/strategist/*.md (frontmatter: id/version/
 * cachePoint) — edit the markdown to change instructions; this module
 * assembles the ordered BODY modules back into the single strategist body
 * and preserves the Bedrock cachePoint block boundary. Version flows into
 * prompt_invocations via STRATEGIST_PERSONA_META.
 *
 * The persona is a tightly-woven XML-skeleton document, not cleanly
 * separable by top-level headers, so several `_base_*` fragments carry the
 * generic role/phase-framework/XML-skeleton/global-rules text that sits
 * BETWEEN the pulled-out section modules (cover-letter, archetype,
 * experience, skills-education, projects, gaps). The array order below
 * reproduces the original top-to-bottom document sequence exactly — that is
 * what the strategist-persona-assembly test proves byte-for-byte against
 * the pre-split golden fixture.
 *
 * `summary` was a duplicate, not a cut, at the time this module split from
 * the monolithic prompt: the summary-composition rules stayed inline in
 * `_base_3` (lossless refactor — the strategist body did not change) and
 * were ALSO copied into `strategist/summary.md` as a standalone persona for
 * a planned separate summary agent. That summary agent now exists
 * (summary-agent.ts / summary-message.ts) and `_base_3` has since been
 * updated to tell the body to leave `summary` as `""` — a dedicated summary
 * pass composes it from `strategist/summary.md`. `strategist/summary` stays
 * excluded from BODY_MODULES so its rules are not duplicated in the
 * assembled body.
 */
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'node:crypto';
import { loadPrompt, toSystemBlocks, type PromptMeta } from './prompt-loader.js';

/** Ordered BODY modules, reproducing the original document's top-to-bottom sequence. */
const BODY_MODULES = [
    'strategist/_base_1',
    'strategist/cover-letter',
    'strategist/_base_2',
    'strategist/archetype',
    'strategist/_base_3',
    'strategist/experience',
    'strategist/skills-education',
    'strategist/projects',
    'strategist/_base_4',
    'strategist/gaps',
    'strategist/_base_5',
] as const;

/** Concatenate the body module bodies in order (verbatim, cache-point markers preserved). */
export function assembleStrategistBody(): string {
    return BODY_MODULES.map((name) => loadPrompt(name).body).join('');
}

/** Composite version: any body-module version change flips this, so the ledger stays honest. */
function compositeVersion(): string {
    const parts = BODY_MODULES.map((name) => `${name}@${loadPrompt(name).meta.version}`).join('|');
    return `body-${createHash('sha256').update(parts).digest('hex').slice(0, 12)}`;
}

const assembledBody = assembleStrategistBody();

export const STRATEGIST_PERSONA_META: PromptMeta = {
    id: 'strategist-persona',
    version: compositeVersion(),
    cachePoint: 'default',
};

// Reuse the loader's block-splitter on the assembled body via a synthetic LoadedPrompt.
export const STRATEGIST_PERSONA_SYSTEM_PROMPT: SystemContentBlock[] = toSystemBlocks({
    meta: STRATEGIST_PERSONA_META,
    body: assembledBody,
});
