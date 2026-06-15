/**
 * @format
 * Source-lane provenance — deterministic classification of where each Skill
 * Evidence Ledger row's evidence was drawn from.
 *
 * The matcher sees three evidence lanes:
 *   - REPO    — standalone code repositories (document_embeddings + technology_evidence)
 *   - PROJECT — documented portfolio project case studies (injected) + the code in a project's repos
 *   - CAREER  — the candidate's résumé / career history (experience facts, injected)
 *
 * A `verified` row's cited code file is `owner/repo/path`; if that `owner/repo`
 * belongs to a documented project we credit PROJECT, otherwise REPO. Rows with
 * no code files are classified by scanning the evidence prose for a documented
 * project name (→ PROJECT) or a career company/title (→ CAREER). A row can draw
 * from more than one lane (e.g. project code + career corroboration).
 *
 * Pure + deterministic + unit-tested. No I/O.
 */
import type { SkillEvidenceEntry, SkillEvidenceLane } from '@bedrock/shared';

/** Inputs for lane classification — all lowercased/normalised by the caller-agnostic helpers here. */
export interface LaneIndex {
    /** `owner/repo` full-names that belong to a documented project. */
    readonly projectRepos: ReadonlySet<string>;
    /** Documented project names (original case; matched case-insensitively). */
    readonly projectNames: readonly string[];
    /** Career identifiers — company + job-title strings (matched case-insensitively). */
    readonly careerTerms: readonly string[];
}

/** Extract `owner/repo` from an `owner/repo/path…` evidence-file path; null if not repo-scoped. */
export function repoOfFile(path: string): string | null {
    const first = path.indexOf('/');
    if (first === -1) return null;
    const second = path.indexOf('/', first + 1);
    if (second === -1) return null;
    const owner = path.slice(0, first);
    const repo = path.slice(first + 1, second);
    return owner.length > 0 && repo.length > 0 ? `${owner}/${repo}` : null;
}

/** True if `haystack` contains any of `needles` (case-insensitive, non-empty needles only). */
function mentionsAny(haystack: string, needles: readonly string[]): boolean {
    const h = haystack.toLowerCase();
    return needles.some((n) => {
        const t = n.trim().toLowerCase();
        return t.length > 0 && h.includes(t);
    });
}

/**
 * Classify one ledger entry's source lane(s). Deterministic, order-stable
 * (repo, project, career). Returns [] only when nothing can be attributed
 * (e.g. an honest gap with no files and no prose match).
 */
export function classifyLanes(entry: SkillEvidenceEntry, index: LaneIndex): SkillEvidenceLane[] {
    const lanes = new Set<SkillEvidenceLane>();

    // Code files → repo or project, by whether the repo belongs to a project.
    for (const file of entry.evidenceFiles) {
        const repo = repoOfFile(file);
        if (!repo) continue;
        if (index.projectRepos.has(repo)) lanes.add('project');
        else lanes.add('repo');
    }

    // Prose attribution (covers file-less career/project evidence + corroboration).
    const prose = `${entry.evidence} ${entry.transferableBridge}`;
    if (prose.trim().length > 0) {
        if (mentionsAny(prose, index.projectNames)) lanes.add('project');
        if (mentionsAny(prose, index.careerTerms)) lanes.add('career');
    }

    // Stable order.
    const order: SkillEvidenceLane[] = ['repo', 'project', 'career'];
    return order.filter((l) => lanes.has(l));
}

/**
 * Attach `sourceLanes` to every entry in a ledger. Entries that classify to no
 * lane are left without the field (keeps gap rows clean). Pure — returns a new
 * array; never mutates input.
 */
export function attachSourceLanes(
    ledger: readonly SkillEvidenceEntry[],
    index: LaneIndex,
): SkillEvidenceEntry[] {
    return ledger.map((entry) => {
        const sourceLanes = classifyLanes(entry, index);
        return sourceLanes.length > 0 ? { ...entry, sourceLanes } : entry;
    });
}
