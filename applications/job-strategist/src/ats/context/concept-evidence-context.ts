/**
 * @format
 * Concept Evidence Context Builder — P2 Task 5.
 *
 * Builds a short LLM-readable context string grounding JD-mentioned "concepts"
 * (higher-level architectural/methodological terms like "observability" or
 * "distributed systems" — distinct from the tech-transfer lane's tools/
 * languages) in deterministic, detector-backed evidence from `concept_evidence`
 * (migration 123). Mirrors `formatTechTransferContext`'s structure: only JD
 * concepts that resolve to a canonical WITH evidence render a line; everything
 * else is omitted so the full ontology is never dumped into the prompt.
 *
 * Pure function — no I/O. Returns '' when no JD concept has evidence.
 */
import type { RepoConceptRow } from '@bedrock/shared';

export type { RepoConceptRow };

/** Lowercase + trim, then alias-map lookup; unmapped terms fall back to their lowercased, trimmed form. */
function resolveCanonical(term: string, aliasToCanonical: ReadonlyMap<string, string>): string {
    const lower = term.toLowerCase().trim();
    return aliasToCanonical.get(lower) ?? lower;
}

interface ConceptAggregate {
    files: number;
    repos: Set<string>;
    detectors: Set<string>;
}

/**
 * Build a short context block for the LLM matcher listing the JD-mentioned
 * concepts that have deterministic code evidence, aggregated across repos and
 * detectors (one line per canonical concept).
 *
 * @param jdConcepts   - Raw JD concept strings (from `jdExtraction.concepts`)
 * @param repoConcepts - Aggregated concept_evidence rows for the user (all repos)
 * @param aliasToCanonical - Skill alias -> canonical map (lowercased keys), the
 *   SAME map `skill_aliases`/`skill_ontology` resolve concept detector aliases
 *   through, so JD mentions and stored evidence speak one vocabulary.
 * @returns Formatted context string, or '' when no JD concept has evidence
 */
export function formatConceptEvidenceContext(
    jdConcepts: string[],
    repoConcepts: RepoConceptRow[],
    aliasToCanonical: Map<string, string>,
): string {
    if (jdConcepts.length === 0 || repoConcepts.length === 0) return '';

    const jdCanonicals = new Set(jdConcepts.map((c) => resolveCanonical(c, aliasToCanonical)));

    const byCanonical = new Map<string, ConceptAggregate>();
    for (const row of repoConcepts) {
        const canonical = row.canonicalName.toLowerCase().trim();
        if (!jdCanonicals.has(canonical)) continue;

        let agg = byCanonical.get(canonical);
        if (agg === undefined) {
            agg = { files: 0, repos: new Set(), detectors: new Set() };
            byCanonical.set(canonical, agg);
        }
        agg.files += row.files;
        agg.repos.add(row.repoFullName);
        agg.detectors.add(row.detector);
    }

    if (byCanonical.size === 0) return '';

    const lines = [...byCanonical.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([canonical, agg]) => {
            const detectors = [...agg.detectors].sort().join(', ');
            const repoWord = agg.repos.size === 1 ? 'repo' : 'repos';
            return `- ${canonical}: ${agg.files} files across ${agg.repos.size} ${repoWord} (detectors: ${detectors})`;
        });

    return ['## Evidenced Concepts', ...lines].join('\n');
}
