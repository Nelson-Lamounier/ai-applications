/**
 * @format
 * Doc-vs-code drift prevention — reconcile documentation claims against the
 * deterministic, code-derived technology truth.
 *
 * THE BUG THIS ADDRESSES: a repo migrates (e.g. self-hosted Kubernetes → EKS) but
 * its `.md` docs are not updated. The KB ingests the stale doc and the resume
 * matcher cites it as current. Meanwhile the code extraction (technology_evidence:
 * IaC/Syft/TreeSitter, see TechnologyOntologyRepository.loadRepoCodeTech) already
 * knows the repo's CURRENT stack is EKS.
 *
 * Two outputs, both pure + deterministic:
 *   1. `buildCodeStackContext` — a grounding block listing each repo's current
 *      code stack, injected into the research prompt as the authoritative truth
 *      (the LLM backstop: prefer code over stale docs).
 *   2. `demoteCodeContradictedMatches` — a deterministic guard that demotes a
 *      verifiedMatch whose documented technology is SUPERSEDED by the code: the
 *      doc names a predecessor `P`, the repo's code lacks `P` but contains a
 *      `succeeds`-successor `S` of `P`. The stale claim becomes a past-tense
 *      partialMatch; it is never presented as the current implementation.
 *
 * The guard only fires on entities with a curated `succeeds` edge (migration 075+)
 * — absence of a tech in code is NEVER treated as contradiction on its own (a tool
 * may simply be undetectable by SBOM/AST). FAIL-SAFE: no edges / no code evidence
 * → no change.
 */

import type { ResearchMatching, VerifiedMatch, PartialMatch } from '@bedrock/shared';
import { log } from '@bedrock/shared';
import { buildReverseAliasMap, mentionsCanonical, padded } from '../matching/keyword-match.js';

/** Extract the `owner/repo` prefix from a KB evidence path (first two segments). */
export function repoOf(path: string): string | null {
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
}

/** Max technologies listed per repo in the grounding block (keeps the prompt bounded). */
const MAX_TECH_PER_REPO = 40;

/**
 * Build the "Current Code Stack" grounding block — each repo's deterministically
 * extracted current technologies, labelled authoritative. Returns '' when empty.
 */
export function buildCodeStackContext(codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>): string {
    if (codeTechByRepo.size === 0) return '';
    const lines: string[] = [
        '## Current Code Stack — AUTHORITATIVE (deterministic extraction from repository code)',
        'Extracted directly from each repo\'s CODE (IaC manifests, SBOM, AST, Dockerfiles) at the',
        'latest commit — this is the CURRENT, factual stack. When a KB doc passage describes a',
        'DIFFERENT technology for the same repo than what is listed here, the doc is STALE: prefer the',
        'code stack, present the code technology as current, and frame the doc-only technology in the',
        'PAST tense (a prior approach) or omit it. Never present a stale doc technology as current.',
        '',
    ];
    for (const [repo, tech] of codeTechByRepo) {
        const names = [...tech].sort((a, b) => a.localeCompare(b)).map((t) => t.replaceAll('_', ' '));
        const shown = names.slice(0, MAX_TECH_PER_REPO);
        const suffix = names.length > MAX_TECH_PER_REPO ? `, …(+${names.length - MAX_TECH_PER_REPO} more)` : '';
        lines.push(`- ${repo}: ${shown.join(', ')}${suffix}`);
    }
    return lines.join('\n');
}

/** A documented technology superseded by the repo's current code. */
export interface CodeContradiction {
    /** The verifiedMatch skill string that named the stale technology. */
    readonly skill: string;
    /** The repo whose code contradicts the doc. */
    readonly repo: string;
    /** The stale (predecessor) canonical the doc claimed. */
    readonly docTech: string;
    /** The successor canonical(s) present in the repo's current code. */
    readonly codeSuccessors: string[];
    /** The KB evidence files the stale claim was cited from (for provenance attribution). */
    readonly evidenceFiles: string[];
}

export interface CodeTruthDeps {
    /** repoFullName -> current code technologies (lowercased canonicals). */
    readonly codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>;
    /** predecessor canonical -> successor canonicals (from `succeeds` edges). */
    readonly succeedsEdges: ReadonlyMap<string, ReadonlySet<string>>;
    /** alias(lower) -> canonical(lower), to resolve a doc phrase to a predecessor entity. */
    readonly aliasToCanonical: ReadonlyMap<string, string>;
}

export interface CodeTruthResult {
    readonly matching: ResearchMatching;
    readonly contradictions: CodeContradiction[];
}

/** The unique `owner/repo` set a match is evidenced from. */
function reposOf(evidenceFiles: ReadonlyArray<string>): string[] {
    const repos = new Set<string>();
    for (const f of evidenceFiles) {
        const r = repoOf(f);
        if (r !== null) repos.add(r);
    }
    return [...repos];
}

/** Find a code contradiction for one match, or null. */
function findContradiction(
    vm: VerifiedMatch,
    predecessors: ReadonlyArray<string>,
    reverse: Map<string, string[]>,
    deps: CodeTruthDeps,
): CodeContradiction | null {
    const repos = reposOf(vm.evidenceFiles ?? []);
    if (repos.length === 0) return null; // career evidence — not repo-scoped, never reconciled
    const hay = padded(vm.skill);
    for (const predecessor of predecessors) {
        if (!mentionsCanonical(predecessor, hay, reverse)) continue; // doc doesn't claim this tech
        const successors = deps.succeedsEdges.get(predecessor);
        if (successors === undefined) continue;
        for (const repo of repos) {
            const codeSet = deps.codeTechByRepo.get(repo);
            if (codeSet === undefined || codeSet.has(predecessor)) continue; // no code truth, or P still used
            const present = [...successors].filter((s) => codeSet.has(s));
            if (present.length > 0) return { skill: vm.skill, repo, docTech: predecessor, codeSuccessors: present, evidenceFiles: vm.evidenceFiles ?? [] };
        }
    }
    return null;
}

/** Build the past-tense partialMatch a code-contradicted verified claim becomes. */
function toStalePartial(vm: VerifiedMatch, hit: CodeContradiction): PartialMatch {
    const docDisplay = hit.docTech.replaceAll('_', ' ');
    const successorDisplay = hit.codeSuccessors.map((s) => s.replaceAll('_', ' ')).join(', ');
    return {
        skill: vm.skill,
        gapDescription: `Documentation for ${hit.repo} describes "${docDisplay}", but the repo's current code shows ${successorDisplay} — the doc is stale (the repo migrated).`,
        transferableFoundation: `Real Kubernetes/platform experience; the repo has since migrated to ${successorDisplay}, which is the current code truth.`,
        framingSuggestion: `Frame "${docDisplay}" in the PAST tense as a prior approach and present ${successorDisplay} as the current stack. Do NOT present "${docDisplay}" as the current implementation.`,
        evidenceFiles: vm.evidenceFiles ?? [],
    };
}

/**
 * Demote verifiedMatches whose documented technology is superseded by the repo's
 * current code (doc names predecessor P; code lacks P but has a `succeeds`-successor
 * of P). Demoted claims become past-tense partialMatches. FAIL-SAFE: no `succeeds`
 * edges or no code evidence → input returned unchanged.
 */
export function demoteCodeContradictedMatches(matching: ResearchMatching, deps: CodeTruthDeps): CodeTruthResult {
    if (deps.succeedsEdges.size === 0 || deps.codeTechByRepo.size === 0) {
        // Distinguish from "ran, 0 contradictions" below: empty succeeds edges or
        // empty code tech here usually means the ontology/code-evidence tables
        // failed to load, not that there is genuinely nothing to reconcile.
        log('WARN', 'code-truth guard SKIPPED — succeedsEdges/codeTechByRepo empty (possible ontology load failure)', {
            succeedsEdgeCount: deps.succeedsEdges.size,
            codeTechRepoCount:  deps.codeTechByRepo.size,
        });
        return { matching, contradictions: [] };
    }

    const reverse = buildReverseAliasMap(deps.aliasToCanonical);
    const predecessors = [...deps.succeedsEdges.keys()];
    const kept: VerifiedMatch[] = [];
    const stale: PartialMatch[] = [];
    const contradictions: CodeContradiction[] = [];

    for (const vm of matching.verifiedMatches) {
        const hit = findContradiction(vm, predecessors, reverse, deps);
        if (hit) {
            stale.push(toStalePartial(vm, hit));
            contradictions.push(hit);
        } else {
            kept.push(vm);
        }
    }

    if (contradictions.length === 0) return { matching, contradictions: [] };
    return {
        matching: { ...matching, verifiedMatches: kept, partialMatches: [...matching.partialMatches, ...stale] },
        contradictions,
    };
}
