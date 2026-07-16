/** @format */

/**
 * Canonical resume section order — a SYSTEM decision, never the model's.
 *
 * The condense/expand rewrite lane's tool schema tolerates a `sectionOrder`
 * key (strictness there turned one extra echoed key into a fatal failure),
 * which let a model-authored order (skills third) reach the persisted resume;
 * the tucaken-app builder honours a backend-emitted order over its own
 * canonical fallback, so the UI mirrored the model's whim. Stamping the order
 * immediately before persist makes this list the single authority.
 *
 * Skills close the document (user decision, 2026-07-16): recruiters read the
 * narrative sections first; the keyword inventory supports rather than leads.
 * Must match the ATS PDF order in render/resume-pdf/build-resume-element.ts.
 * Keys are the tucaken-app builder's section keys; unknown keys are filtered
 * out on the UI side, so `profile` (always rendered as the header) is omitted.
 */
export const CANONICAL_SECTION_ORDER: readonly string[] = [
    'summary',
    'experience',
    'projects',
    'education',
    'certifications',
    'skills',
];

/** Return a copy of the resume carrying the canonical section order. */
export function stampCanonicalSectionOrder<T extends object>(resume: T): T & { sectionOrder: string[] } {
    return { ...resume, sectionOrder: [...CANONICAL_SECTION_ORDER] };
}
