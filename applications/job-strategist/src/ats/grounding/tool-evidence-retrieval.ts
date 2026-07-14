/**
 * @format
 * Skill Evidence Ledger — structured code-evidence enrichment.
 *
 * "What your repos prove" must cite REAL code, not whatever reads similarly. Cosine
 * retrieval (used previously here) ranks prose docs above code and matches files by
 * lexical name overlap — so a soft skill like "complex technical communication" got
 * attached to a frontend component named CompanyProblemPanel.tsx. That is the wrong
 * question ("what reads like this?") for a proof lane.
 *
 * This module instead attaches the actual CODE files that use a skill's technology,
 * from the deterministic technology_evidence lane (TechnologyOntologyRepository.
 * loadCanonicalToCodeFiles). A ledger entry is enriched ONLY when BOTH hold:
 *   (a) the skill resolves to a tech canonical the user actually has IN CODE, and
 *   (b) it was not already grounded purely in experience (matcher gave no files).
 * Soft/experience skills therefore keep their honest career grounding (no files);
 * gap entries are never touched. No embeddings, no I/O — pure + deterministic.
 */

import type { SkillEvidenceEntry } from '@bedrock/shared';
import { buildReverseAliasMap, mentionsCanonical, padded } from '../matching/keyword-match.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LedgerEvidenceDeps {
    /** canonical(lower) → code file paths that use it (technology_evidence, code layers). */
    readonly canonicalToFiles: ReadonlyMap<string, ReadonlyArray<string>>;
    /** alias(lower) → canonical(lower) — resolves a JD skill phrase to a tech canonical. */
    readonly aliasToCanonical: ReadonlyMap<string, string>;
}

export interface LedgerEvidenceOpts {
    /** Maximum code files to attach per entry (default: 3). */
    readonly topN?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicals whose lowercase token collides with a differently-cased term of
 * art: "ReAct" (agent pattern) case-folds to "react" (UI library); same class
 * as Go/go and Ray/ray. For these canonicals the SOURCE phrase must contain
 * one of the accepted spellings as a case-exact whole word, or the canonical
 * does not resolve — this is what stopped "ReAct" citing react-pdf.ts as
 * evidence. Extensible: add an entry whenever a new collision is discovered.
 */
const CASE_SENSITIVE_CANONICALS: ReadonlyMap<string, readonly string[]> = new Map([
    ['react', ['react', 'React', 'REACT', 'react.js', 'React.js', 'ReactJS', 'reactjs']],
    ['go',    ['Go', 'GO', 'golang', 'Golang', 'GoLang', 'GOLANG']],
    ['ray',   ['Ray', 'RAY']],
    ['dash',  ['Dash', 'DASH']],
]);

function escapeRegExp(s: string): string {
    return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * True when `phrase` contains an accepted case-exact spelling of `canonical`
 * (always true for canonicals with no registered collision).
 */
function caseAccepted(phrase: string, canonical: string): boolean {
    const accepted = CASE_SENSITIVE_CANONICALS.get(canonical);
    if (!accepted) return true;
    return accepted.some((form) =>
        new RegExp(String.raw`(?<![A-Za-z0-9])${escapeRegExp(form)}(?![A-Za-z0-9])`).test(phrase),
    );
}

/**
 * Lockfiles and build artifacts are never citable evidence — a dependency
 * pin proves installation, not use, and reads as padding on the evidence
 * panel (yarn.lock cited as ReAct proof was the founding instance).
 */
const NON_CITABLE_FILE_RE = /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|go\.sum|Gemfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock)$|(^|\/)(dist|build|node_modules|\.yarn|cdk\.out|coverage)\//i;

/** Filter a file list down to citable evidence (drops lockfiles/build output). */
export function citableFiles(files: readonly string[]): string[] {
    return files.filter((f) => !NON_CITABLE_FILE_RE.test(f));
}

/**
 * Resolve a skill phrase to a tech canonical the user HAS in code, or null. Scans only
 * the canonicals present in code evidence (≤ a few hundred), so a match means there is
 * real code to cite. Whole-token match via the alias reverse map — "Python scripting and
 * automation" → python; "Complex technical communication" → null (no code canonical named).
 * Collision-guarded: a canonical registered in CASE_SENSITIVE_CANONICALS additionally
 * requires a case-exact spelling in the ORIGINAL phrase ("ReAct" never resolves to react).
 */
function resolveCodeCanonical(
    skill: string,
    canonicalToFiles: LedgerEvidenceDeps['canonicalToFiles'],
    reverse: Map<string, string[]>,
): string | null {
    const hay = padded(skill);
    for (const canonical of canonicalToFiles.keys()) {
        if (mentionsCanonical(canonical, hay, reverse) && caseAccepted(skill, canonical)) return canonical;
    }
    return null;
}

/**
 * Code files for any canonical NAMED in a transferable bridge — the interchangeable
 * alternatives the candidate actually uses (e.g. a vendor-provenance bridge "…uses an
 * interchangeable alternative (aws bedrock, anthropic claude, amazon titan)"). Lets a
 * vendor-transferable skill (OpenAI/Codex) cite the Bedrock/Claude code that proves it.
 * Deduped; preserves canonicalToFiles ordering.
 */
function filesFromBridge(
    bridge: string,
    canonicalToFiles: LedgerEvidenceDeps['canonicalToFiles'],
    reverse: Map<string, string[]>,
): string[] {
    if (!bridge) return [];
    const hay = padded(bridge);
    const files: string[] = [];
    const seen = new Set<string>();
    for (const [canonical, paths] of canonicalToFiles) {
        if (!mentionsCanonical(canonical, hay, reverse) || !caseAccepted(bridge, canonical)) continue;
        for (const p of paths) {
            if (!seen.has(p)) { seen.add(p); files.push(p); }
        }
    }
    return citableFiles(files);
}

// ---------------------------------------------------------------------------
// attachCodeEvidence
// ---------------------------------------------------------------------------

/**
 * Attach structured code-file evidence to a Skill Evidence Ledger.
 *
 * Per non-gap entry:
 *  - resolve the skill to a code-present canonical (a); experienceGrounded = the matcher
 *    cited no files (b). Enrich ONLY when a canonical resolves AND it was not experience-
 *    grounded — otherwise return the entry unchanged (soft/experience skills stay honest).
 *  - when enriching: REPLACE the matcher files with structured code files (structured-only
 *    proof — a code-demonstrable skill cites code, not the matcher's docs).
 *  - gap entries: never touched. Pure + deterministic; no retrieval, no embeddings.
 */
export function attachCodeEvidence(
    ledger: SkillEvidenceEntry[],
    deps: LedgerEvidenceDeps,
    opts?: LedgerEvidenceOpts,
): SkillEvidenceEntry[] {
    const topN = opts?.topN ?? 3;
    const reverse = buildReverseAliasMap(deps.aliasToCanonical);

    return ledger.map((entry) => {
        if (entry.status === 'gap') return entry;                       // honesty invariant

        const canonical = resolveCodeCanonical(entry.tool, deps.canonicalToFiles, reverse);
        if (!canonical) {
            // VENDOR-TRANSFERABLE: the named tool itself isn't in code (e.g. "OpenAI API"),
            // but the candidate uses an interchangeable alternative that IS (Bedrock/Claude).
            // The transferable bridge names those alternatives — cite THEIR real code files so
            // the skill links repo proof like a verified one, instead of showing nothing.
            if (entry.status === 'transferable') {
                const altFiles = filesFromBridge(entry.transferableBridge, deps.canonicalToFiles, reverse);
                if (altFiles.length > 0) return { ...entry, evidenceFiles: altFiles.slice(0, topN) };
            }
            // SOFT / experience skill (no code canonical, e.g. "complex technical
            // communication"): its proof is the career citation, NOT a repo file. Strip
            // any repo files the matcher attached by lexical similarity — that is how a
            // résumé-data file (tucaken-app/src/lib/resumes/resume-data.ts) ended up
            // "proving" communication. Already-empty entries are returned untouched.
            return entry.evidenceFiles.length === 0 ? entry : { ...entry, evidenceFiles: [] };
        }

        // CODE skill grounded purely in experience (matcher cited nothing): leave as-is.
        if (entry.evidenceFiles.length === 0) return entry;

        const codeFiles = citableFiles(deps.canonicalToFiles.get(canonical) ?? []);
        if (codeFiles.length === 0) return entry;                       // no code proof → keep matcher files

        // Structured-only: cite the real code files, not the matcher's (possibly doc) files.
        return { ...entry, evidenceFiles: codeFiles.slice(0, topN) };
    });
}
