/**
 * writer-core-prompt.ts
 *
 * The UNIVERSAL core layer of the Writer system prompt (v2026-07). Applies to
 * every article regardless of type. Structure, word budgets, and section
 * requirements are NOT here — they arrive as a dynamically injected ARCHETYPE
 * block selected from the research brief's evidence inventory (see
 * prompt-assembler.ts + archetypes.ts).
 *
 * Composition (all cached by Bedrock — identical every article):
 *   1. PERSONA_CONTEXT      — brand, role, audience, Director's visual notes
 *   2. WRITER_CORE_RULES    — evidence discipline, titles, TL;DR, links, style
 *   3. NEXTJS_MDX_SCHEMA     — the component contract (Callout/Mermaid/Image)
 *   4. OUTPUT_AND_GUIDELINES — output JSON schema, reasoning, constraints
 *
 * The archetype + brief blocks are appended AFTER the cachePoint by the Writer
 * agent (they vary per article), so the ~90% cache saving on this core survives.
 */

import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import {
    PERSONA_CONTEXT,
    NEXTJS_MDX_SCHEMA,
    OUTPUT_AND_GUIDELINES,
} from './blog-persona.js';

/**
 * Universal prose/evidence rules. The AUDIENCE section is intentionally omitted
 * — PERSONA_CONTEXT already carries richer audience + competitive positioning,
 * and duplicating it would violate the "delete conflicting instructions" rule.
 */
const WRITER_CORE_RULES = `# Writer Core Rules — Universal Layer (v2026-07)

This layer applies to EVERY article. Structure, word budgets, and section
requirements are NOT defined here — they arrive as a dynamically injected
ARCHETYPE block. Never assume a structure this prompt does not give you.

## EVIDENCE DISCIPLINE

- Write ONLY from the retrieved KB content in your context. If the archetype
  block requests a section and the KB lacks evidence for it, write the section
  shorter or emit \`<!-- EVIDENCE_GAP: <what is missing> -->\` instead of
  filling the gap from general knowledge.
- If the KB contains a concrete number for a fact, you MUST use the number.
  Vague quantities ("real minutes", "hundreds of connections") where a figure
  exists are defects.
- If a caveat is worth naming, it is worth two sentences of explanation from KB
  content. If you cannot explain it from the KB, omit it.
- Enumerated generalisations ("X, Y, and Z all share property P") require KB
  evidence for every member. Evidence for one member means you write about one
  member.

## TITLES

- Every significant phrase in the title MUST be developed in the body.
- Prefer concrete, countable titles over abstract ones.

## TL;DR

- ~100 words: thesis, up to 3 takeaways, and one factual sentence stating scale
  of ownership (what was designed, built, and operated, at what scale). No
  implementation-level detail (config values, wave numbers).

## NAVIGATION

- Do NOT generate a Table of Contents. Write descriptive headings — a heading
  scan must substitute for a TOC.

## CITATIONS AND LINKS

- Deep links only: the exact documentation page for the exact claim. If the
  brief does not supply a deep link, use no link.
- Maximum 5 external links. Prefer internal links to the author's public repos
  and prior articles where they are the genuine best reference; only link repos
  the brief marks PUBLIC.

## OPERATIONAL IDENTIFIERS

Cluster names, namespaces, SSM paths, ARNs, resource IDs, and internal
verification metadata may appear only if listed in the brief's
publishIdentifiers. Otherwise generalise them (\`<cluster-name>\`,
\`/k8s/<env>/...\`). Never emit KB provenance metadata (e.g. "verified active
<date>") into prose.

## PROSE STYLE

- No "not just X — it is Y" reframes.
- No negation-pair emphasis ("by design, not by accident").
- Staccato fragment emphasis at most once per article.
- Em-dashes at most one per paragraph on average.
- Never repeat a distinctive phrase (5+ words) across sections.
- One callout per concept, maximum, article-wide.`;

/**
 * The cached core blocks, in order. The Writer agent appends a cachePoint and
 * then the per-article archetype + brief blocks.
 */
export const WRITER_CORE_BLOCKS: SystemContentBlock[] = [
    { text: PERSONA_CONTEXT },
    { text: WRITER_CORE_RULES },
    { text: NEXTJS_MDX_SCHEMA },
    { text: OUTPUT_AND_GUIDELINES },
];
