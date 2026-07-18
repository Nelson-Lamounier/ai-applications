/**
 * @format
 * Pure, deterministic classifier for the concept coverage eval (P2 Task 5).
 *
 * Given a stored JD "concept" mention (`jdExtraction.concepts`), decides
 * whether it is:
 *  - `covered`         — resolves to a skill_ontology canonical the user has
 *    at least one `concept_evidence` row for (migration 123 detector facts).
 *  - `uncovered`        — resolves to a real ontology canonical, but the user
 *    has no concept_evidence for it.
 *  - `unknown-concept`  — does not resolve to any `skill_ontology` canonical
 *    at all (e.g. career-only terms like "technical support" that concept
 *    detectors were never built to evidence). Never counted as coverage.
 *
 * No I/O, no Bedrock. Zero LLM. Reused by `run-concept-coverage-eval.ts` per
 * stored JD concept mention.
 */

export type ConceptCoverageKind = 'covered' | 'uncovered' | 'unknown-concept';

export interface ConceptCoverageClassification {
    readonly classification: ConceptCoverageKind;
    /** Lowercased canonical name the concept string resolved to. */
    readonly canonical: string;
}

/** Lowercase + alias-map lookup. Accepts either a live `Map` (as returned by
 *  `SkillOntologyRepository.loadAliasToCanonicalMap()`) or a plain `Record`
 *  (JSON-friendly, e.g. loaded from a fixture). Unmapped terms fall back to
 *  their lowercased, trimmed form — no further normalisation. */
function canonicaliseConcept(
    concept: string,
    aliasToCanonical: Map<string, string> | Record<string, string>,
): string {
    const lower = concept.toLowerCase().trim();
    const mapped = aliasToCanonical instanceof Map
        ? aliasToCanonical.get(lower)
        : aliasToCanonical[lower];
    return mapped ?? lower;
}

/**
 * Classify one JD concept mention against the ontology's full canonical set
 * (`unknown-concept` gate) and the user's evidenced concept canonicals
 * (`covered` vs `uncovered`).
 *
 * The ontology-membership check runs FIRST and is authoritative: a canonical
 * absent from `ontologyCanonicals` can never classify as `covered`, however
 * it appears in `evidencedCanonicals` — this is the structural guarantee the
 * eval's sanity assertion re-verifies over the classified output.
 */
export function classifyConceptCoverage(
    concept: string,
    evidencedCanonicals: ReadonlySet<string>,
    ontologyCanonicals: ReadonlySet<string>,
    aliasToCanonical: Map<string, string> | Record<string, string>,
): ConceptCoverageClassification {
    const canonical = canonicaliseConcept(concept, aliasToCanonical);

    if (!ontologyCanonicals.has(canonical)) {
        return { classification: 'unknown-concept', canonical };
    }

    if (evidencedCanonicals.has(canonical)) {
        return { classification: 'covered', canonical };
    }

    return { classification: 'uncovered', canonical };
}
