/**
 * @format
 * Evidence-metadata stamp — the structural "verified authorship" signals copied
 * onto every chunk's document_embeddings.metadata so retrieval can filter without a
 * join (filter-then-rank, docs/retrieval-filter-then-rank-spec.md, Increment 1).
 *
 * Pure builder: per-repo signals → the metadata patch. The SQL that loads the
 * signals (repository_profiles + oauth_connections + repo_commits +
 * technology_evidence) and applies the patch lives in the repository layer.
 *
 * Stamped at ingestion (and back-fillable on demand, since every source table is
 * already populated). One repo's stamp is applied to all its chunks, so the repo
 * truth is written by ONE writer per sync — no decoupled job, no drift.
 */

export interface RepoSignals {
    readonly repoFullName: string;
    /** repository_profiles.classification: project | fork | tutorial | stale | noise. */
    readonly classification: string | null;
    /** repository_profiles.quality_score (0..1). */
    readonly qualityScore: number | null;
    /** The repo owner (full_name prefix) equals the user's connected github login. */
    readonly ownerIsUser: boolean;
    /** The user's github login appears in this repo's commit authors (repo_commits.author_login). */
    readonly userAuthored: boolean;
    /** Code-derived current tech (technology_evidence canonicals). */
    readonly techStack: readonly string[];
    /** repo_profile.repo_type / domain, when known. */
    readonly domain: string | null;
}

export interface EvidenceStamp {
    /** HARD retrieval gate — fork code is never the candidate's authorship. */
    readonly is_fork: boolean;
    readonly repo_classification: string;
    /** SOFT rank signal (0..1). */
    readonly repo_confidence: number;
    /** The user demonstrably authored this repo (owns it and/or committed to it). */
    readonly authored: boolean;
    /** Authorship could NOT be confirmed — frame contributions cautiously, never "built". */
    readonly role_inferred: boolean;
    /** The user is the repo owner (their github login == the repo owner). */
    readonly owner_is_user: boolean;
    readonly repo_tech_stack: string[];
    readonly repo_domain: string | null;
}

/**
 * Build the per-repo metadata stamp. `authored` is the direct evidence (the user
 * committed to the repo) OR repo ownership; `role_inferred` is its negation — used
 * to keep the resume from claiming authorship of code the user did not write (a
 * referenced third-party repo like `sindresorhus/is` is owned by someone else and
 * has no user commits → authored=false, role_inferred=true).
 */
export function buildEvidenceStamp(s: RepoSignals): EvidenceStamp {
    const isFork = s.classification === 'fork';
    // Authored when the user committed to the repo, or owns it (and it isn't a fork).
    const authored = !isFork && (s.userAuthored || s.ownerIsUser);
    return {
        is_fork: isFork,
        repo_classification: s.classification ?? 'unknown',
        repo_confidence: typeof s.qualityScore === 'number' ? s.qualityScore : 0,
        authored,
        role_inferred: !authored,
        owner_is_user: s.ownerIsUser,
        repo_tech_stack: [...s.techStack].sort((a, b) => a.localeCompare(b)),
        repo_domain: s.domain,
    };
}
