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
import { buildExtractionUserMessage, ENRICH_TOOL_SCHEMA } from './extractionBody.js';

export const ENRICH_CANONICAL_SYSTEM_PROMPT = [
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
    '  - You MUST respond by calling the record_extraction tool.',
].join('\n');

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

export interface CanonicalSplit {
    /** In-vocabulary canonical skills — written to the chunk (the overlap lane). */
    readonly canonical: string[];
    /** Out-of-vocabulary capabilities the model surfaced — the vocabulary growth queue. */
    readonly newSkills: string[];
}

/**
 * Split the model's raw output into in-vocabulary canonical skills and NEW: gaps.
 * A term counts as canonical ONLY if it is in the vocabulary verbatim (lowercased)
 * — anything else (an explicit "NEW: x", OR a non-vocab term the model emitted
 * without the prefix) goes to the growth queue, so non-canonical strings never
 * pollute the corpus. Pure + deterministic.
 */
export function parseCanonicalSkills(rawSkills: readonly unknown[], vocabulary: ReadonlySet<string>): CanonicalSplit {
    const canonical = new Set<string>();
    const newSkills = new Set<string>();
    for (const raw of rawSkills) {
        if (typeof raw !== 'string') continue;
        const s = raw.trim().toLowerCase();
        if (s.length === 0) continue;
        if (s.startsWith('new:')) {
            const term = s.slice(4).trim();
            if (term) newSkills.add(term);
        } else if (vocabulary.has(s)) {
            canonical.add(s);
        } else {
            newSkills.add(s);   // off-vocab without the prefix -> still a gap, never a corpus skill
        }
    }
    return { canonical: [...canonical], newSkills: [...newSkills] };
}
