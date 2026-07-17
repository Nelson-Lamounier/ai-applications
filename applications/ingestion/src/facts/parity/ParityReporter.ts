/** @format */
import type { OntologyResolver } from '@bedrock/shared';

export interface ParityResult {
    l1CanonicalCount:     number;
    llmCanonicalCount:    number;
    llmUnresolvableCount: number;
    intersectionCount:    number;
    recall:               number;
    l1OnlyExamples:       string[];
    llmOnlyExamples:      string[];
}

/**
 * Compare L1 canonical ids against the LLM enricher's free-form technology
 * strings, resolving the LLM strings through the SAME resolver so the metric
 * isn't polluted by the LLM's un-canonicalised noise.
 */
export function computeParity(
    resolver: OntologyResolver,
    l1CanonicalIds: Set<string>,
    llmTechnologies: string[],
): ParityResult {
    const llmResolved = new Set<string>();
    let unresolvable = 0;
    const idToName = new Map<string, string>(); // id -> original llm string
    for (const t of llmTechnologies) {
        const id = resolver.resolve(t);
        if (id) { llmResolved.add(id); if (!idToName.has(id)) idToName.set(id, t); }
        else unresolvable++;
    }

    let intersection = 0;
    const llmOnly: string[] = [];
    for (const id of llmResolved) {
        if (l1CanonicalIds.has(id)) intersection++;
        else llmOnly.push(idToName.get(id)!);
    }
    const l1Only = [...l1CanonicalIds].filter((id) => !llmResolved.has(id));

    const denom = llmResolved.size;
    return {
        l1CanonicalCount:     l1CanonicalIds.size,
        llmCanonicalCount:    llmResolved.size,
        llmUnresolvableCount: unresolvable,
        intersectionCount:    intersection,
        recall:               denom === 0 ? 1 : intersection / denom,
        l1OnlyExamples:       l1Only.slice(0, 25),
        llmOnlyExamples:      llmOnly.slice(0, 25),
    };
}
