/**
 * @format
 * Controlled-vocabulary skill extraction (the vocabulary fix). The enricher emits
 * skills ONLY from a controlled vocabulary (the SAME skill_ontology the JD
 * extractor uses), so corpus + query speak one canonical language and the
 * `d.skills && query.skills` overlap lane actually fires. A "NEW:" escape lets the
 * model surface a genuine gap instead of forcing a capability onto a wrong term —
 * the NEW: stream is the vocabulary's growth queue (proprietary, usage-grown:
 * JD demand primary, recurring repo NEW: secondary; no external registry).
 *
 * Pure builders/parser here (unit-tested without a model); the enricher wires the
 * Bedrock call + the NEW: capture.
 */
import {
    buildExtractionUserMessage,
    buildPackUserMessage,
    ENRICH_TOOL_SCHEMA,
    ENRICH_PACK_TOOL_SCHEMA,
    parsePackSkills,
    type PackBodyItem,
} from './extractionBody.js';

const ENRICH_CANONICAL_RULES = [
    'You are a skill-evidence extractor for a resume-generation system.',
    'Identify the domain capabilities this chunk EVIDENCES the user has practised.',
    '',
    'Emit skills ONLY from the CONTROLLED VOCABULARY provided below. For each',
    'capability the chunk demonstrates, choose the SINGLE closest vocabulary term',
    'and use it VERBATIM (exact characters).',
    '  - Do NOT invent phrasings, sub-grains, or synonyms of a vocabulary term.',
    '  - If the chunk genuinely evidences a capability with NO close vocabulary',
    '    term, emit it prefixed "NEW: " (e.g. "NEW: webassembly"). Do NOT force a',
    '    real capability onto a wrong term — surfacing the gap is correct.',
    '  - Judge ONLY this chunk\'s content; do not infer from path or repo name.',
    '  - Lowercased. Deduplicate. Empty array is valid when no signal is present.',
].join('\n');

export const ENRICH_CANONICAL_SYSTEM_PROMPT =
    `${ENRICH_CANONICAL_RULES}\n  - You MUST respond by calling the record_extraction tool.`;

/** Pack twin of the canonical prompt — same rules, keyed tool. */
export const ENRICH_CANONICAL_PACK_SYSTEM_PROMPT =
    `${ENRICH_CANONICAL_RULES}\n  - You MUST respond by calling the record_extractions tool, one entry per chunk.`;

/** Anthropic Messages body for controlled-vocabulary extraction (vocab in the cached-eligible prefix). */
export function buildCanonicalExtractionBody(
    vocabulary: readonly string[],
    filePath: string,
    content: string,
    heading?: string,
): Record<string, unknown> {
    const system = `${ENRICH_CANONICAL_SYSTEM_PROMPT}\n\nCONTROLLED VOCABULARY (${vocabulary.length} terms — choose only from these):\n${vocabulary.join('\n')}`;
    return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        512,
        temperature:       0,
        system,
        tools:             [ENRICH_TOOL_SCHEMA],
        tool_choice:       { type: 'tool', name: 'record_extraction' },
        messages:          [{ role: 'user', content: buildExtractionUserMessage(filePath, content, heading) }],
    };
}

/**
 * Anthropic Messages body for a PACK of chunks under the controlled vocabulary
 * (feature 004 applied to the canonical/deferred lane). The vocabulary + rules
 * are paid ONCE per pack instead of once per chunk — with production defaulting
 * DEFER_ENRICHMENT=1 + ENRICH_CANONICAL=1, this is the pass where the per-chunk
 * prompt overhead actually bills, so this is where packing must live.
 * `max_tokens` scales with pack size, mirroring buildPackExtractionBody.
 */
export function buildCanonicalPackExtractionBody(
    vocabulary: readonly string[],
    items: readonly PackBodyItem[],
): Record<string, unknown> {
    const system = `${ENRICH_CANONICAL_PACK_SYSTEM_PROMPT}\n\nCONTROLLED VOCABULARY (${vocabulary.length} terms — choose only from these):\n${vocabulary.join('\n')}`;
    return {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        Math.min(4000, 128 + items.length * 160),
        temperature:       0,
        system,
        tools:             [ENRICH_PACK_TOOL_SCHEMA],
        tool_choice:       { type: 'tool', name: 'record_extractions' },
        messages:          [{ role: 'user', content: buildPackUserMessage(items) }],
    };
}

export interface CanonicalSplit {
    /** In-vocabulary canonical skills — written to the chunk (the overlap lane). */
    readonly canonical: string[];
    /** Out-of-vocabulary capabilities the model surfaced — the vocabulary growth queue. */
    readonly newSkills: string[];
}

/**
 * Pack twin of {@link parseCanonicalSkills}: key -> CanonicalSplit from a
 * record_extractions tool_use. Missing keys are simply absent (caller falls
 * those chunks back to per-chunk). Pure + deterministic — reuses the pack
 * key/shape parser and the SAME canonical/alias resolution per entry.
 */
export function parseCanonicalPackSkills(
    content: ReadonlyArray<{ type: string; name?: string; input?: { extractions?: unknown } }>,
    vocabulary: ReadonlySet<string>,
    aliasToCanonical?: ReadonlyMap<string, string>,
): Map<string, CanonicalSplit> {
    const rawByKey = parsePackSkills(content);
    const out = new Map<string, CanonicalSplit>();
    for (const [key, raw] of rawByKey) {
        out.set(key, parseCanonicalSkills(raw, vocabulary, aliasToCanonical));
    }
    return out;
}

/**
 * Split the model's raw output into in-vocabulary canonical skills and NEW: gaps.
 * A term resolves to canonical if it is in the vocabulary verbatim OR maps to a
 * canonical via `aliasToCanonical` — the model is given only canonical NAMES but
 * naturally emits alias phrasings ("aws dynamodb" for canonical "dynamodb"), so
 * without alias resolution those real skills get wrongly queued as NEW: (and the
 * canonical match lost — the precision drag observed live). Only a term that
 * resolves to NO canonical is a genuine gap. Pure + deterministic.
 */
export function parseCanonicalSkills(
    rawSkills: readonly unknown[],
    vocabulary: ReadonlySet<string>,
    aliasToCanonical?: ReadonlyMap<string, string>,
): CanonicalSplit {
    const canonical = new Set<string>();
    const newSkills = new Set<string>();
    for (const raw of rawSkills) {
        if (typeof raw !== 'string') continue;
        const s = raw.trim().toLowerCase();
        if (s.length === 0) continue;
        const core = s.startsWith('new:') ? s.slice(4).trim() : s;
        if (!core) continue;
        // Resolve verbatim-canonical first, then alias -> canonical.
        const resolved = vocabulary.has(core) ? core : aliasToCanonical?.get(core);
        if (resolved && vocabulary.has(resolved)) {
            canonical.add(resolved);          // real skill (possibly via alias) -> corpus
        } else {
            newSkills.add(core);              // resolves to no canonical -> genuine growth-queue gap
        }
    }
    return { canonical: [...canonical], newSkills: [...newSkills] };
}
