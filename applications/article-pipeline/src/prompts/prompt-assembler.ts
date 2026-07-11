/**
 * prompt-assembler.ts
 *
 * Assembles the Writer agent's system prompt at runtime:
 *
 *   core layer (static markdown, CACHED by Bedrock)
 *     + archetype block (selected from the brief's evidence inventory)
 *     + brief-specific dynamic values (word target, identifiers, links)
 *
 * Sits in the article-worker between the Research and Writer steps:
 *
 *   const research = await executeResearchAgent(ctx);        // emits brief
 *   const sel = selectArchetype(research.evidenceInventory);
 *   if (!sel.eligible) return failPipeline(sel.fallbackReason);
 *   const dynamic = assembleDynamicBlock(sel, brief);        // uncached suffix
 *   // system = [ ...coreBlocks, cachePoint, { text: dynamic } ]
 *
 * The Bedrock call already carries the RAG/KB content in its context; this
 * module only shapes the INSTRUCTIONS around that content. It never touches
 * retrieval.
 *
 * Caching: the CORE layer is identical for every article and is placed before
 * the Bedrock cachePoint. The archetype + brief blocks vary per article and sit
 * after it (uncached). assembleDynamicBlock() returns exactly that suffix.
 */

import type { EvidenceInventory } from '@bedrock/shared';
import type { Archetype, SelectionResult } from './archetypes.js';
import { selectArchetype } from './archetypes.js';

// ---------------------------------------------------------------------------
// Brief contract — the structured fields the Research agent must emit
// ---------------------------------------------------------------------------

export interface ResearchBrief {
  slug: string;
  topic: string;
  evidenceInventory: EvidenceInventory;
  /** Verified deep links: url + the claim each supports. */
  citableLinks: Array<{ url: string; supportsClaim: string }>;
  /** Repos marked PUBLIC that may be linked. */
  publicRepos: string[];
  /** Identifiers explicitly cleared for publication (default: none). */
  publishIdentifiers: string[];
  /** Concrete figures retrieved from the KB, with what each measures. */
  availableMetrics: Array<{ value: string; measures: string }>;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderSection(
  s: Archetype['sections'][number],
  totalWords: number,
): string {
  const words = Math.round(totalWords * s.budgetShare);
  return `### Section: ${s.name} (~${words} words)\n${s.instruction}`;
}

function renderArchetypeBlock(sel: SelectionResult): string {
  const a = sel.archetype;
  const target = Math.round((a.totalWords.min + a.totalWords.max) / 2);
  const parts = [
    `## ARCHETYPE: ${a.displayName}`,
    `Selected from the brief's evidence inventory (score ${sel.score}). ` +
      `Total length: ${a.totalWords.min}-${a.totalWords.max} words.`,
    `Title guidance: ${a.titleGuidance}`,
    ...a.sections.map((s) => renderSection(s, target)),
  ];
  if (sel.gapWarnings.length > 0) {
    parts.push(
      '## EVIDENCE GAPS\n' +
        'The following sections have thin evidence. Write them SHORT or ' +
        'emit an EVIDENCE_GAP comment — do not pad from general knowledge:\n' +
        sel.gapWarnings.map((w) => `- ${w}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

function renderBriefBlock(brief: ResearchBrief): string {
  const links =
    brief.citableLinks.length > 0
      ? brief.citableLinks
          .map((l) => `- ${l.url} — supports: ${l.supportsClaim}`)
          .join('\n')
      : '- NONE. Use no external links.';
  const metrics =
    brief.availableMetrics.length > 0
      ? brief.availableMetrics
          .map((m) => `- ${m.value} — ${m.measures}`)
          .join('\n')
      : '- NONE retrieved. Do not invent precision.';
  const identifiers =
    brief.publishIdentifiers.length > 0
      ? brief.publishIdentifiers.map((i) => `- ${i}`).join('\n')
      : '- NONE. Generalise all operational identifiers.';
  const repos =
    brief.publicRepos.length > 0
      ? brief.publicRepos.map((r) => `- ${r}`).join('\n')
      : '- NONE. Do not link any repository.';

  return [
    "## THIS ARTICLE'S CONSTRAINTS",
    `Topic: ${brief.topic}`,
    `### Citable deep links (the ONLY permitted external links)\n${links}`,
    `### Metrics available (MUST be used where the prose states the fact)\n${metrics}`,
    `### Identifiers cleared for publication\n${identifiers}`,
    `### Linkable public repos\n${repos}`,
  ].join('\n\n');
}

/**
 * The per-article suffix (archetype + brief) that sits AFTER the Bedrock
 * cachePoint. Throws if the selection is ineligible — callers must gate on
 * `selection.eligible` before generation.
 */
export function assembleDynamicBlock(
  selection: SelectionResult,
  brief: ResearchBrief,
): string {
  if (!selection.eligible) {
    throw new Error(
      `Refusing to assemble Writer prompt: ${selection.fallbackReason}`,
    );
  }
  return [renderArchetypeBlock(selection), renderBriefBlock(brief)].join(
    '\n\n---\n\n',
  );
}

/**
 * Compose the full Writer system prompt as a single string (core + dynamic).
 * Used by tests and non-cached callers; the pipeline uses assembleDynamicBlock
 * with a cachePoint after the core blocks.
 *
 * @param corePrompt  Contents of the universal core layer.
 * @param selection   Result of selectArchetype(brief.evidenceInventory).
 * @param brief       The Research agent's structured brief.
 */
export function assembleWriterPrompt(
  corePrompt: string,
  selection: SelectionResult,
  brief: ResearchBrief,
): string {
  return [corePrompt.trim(), assembleDynamicBlock(selection, brief)].join(
    '\n\n---\n\n',
  );
}

/** Convenience: brief in, prompt out. Throws when no archetype is eligible. */
export function buildPromptFromBrief(
  corePrompt: string,
  brief: ResearchBrief,
): { prompt: string; selection: SelectionResult } {
  const selection = selectArchetype(brief.evidenceInventory);
  return {
    prompt: assembleWriterPrompt(corePrompt, selection, brief),
    selection,
  };
}
