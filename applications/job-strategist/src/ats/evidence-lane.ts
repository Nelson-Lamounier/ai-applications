/**
 * @format
 * Source-lane provenance — deterministic classification of where each Skill
 * Evidence Ledger row's evidence was drawn from.
 *
 * The matcher sees three evidence lanes — code leads, the rest add context:
 *   - REPO    — code-grounded proof: any cited `owner/repo/path` file. The
 *               concrete path, regardless of whether the repo is also catalogued
 *               as a project. This is the lead signal.
 *   - PROJECT — a documented portfolio case study named in the evidence prose.
 *               Written context that corroborates the code, never the lead.
 *   - CAREER  — the candidate's résumé / career history (experience facts).
 *
 * A row with cited code files always credits REPO (proven in code). Prose is then
 * scanned for a documented project name (→ PROJECT, the write-up that frames the
 * work) or a career company/title (→ CAREER). A row can draw from more than one
 * lane — e.g. repo code described in a project case study and corroborated by a
 * career role yields [repo, project, career], repo first.
 *
 * Pure + deterministic + unit-tested. No I/O.
 */
import type { SkillEvidenceEntry, SkillEvidenceLane } from '@bedrock/shared';

/** Inputs for lane classification — all lowercased/normalised by the caller-agnostic helpers here. */
export interface LaneIndex {
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
 * Expand lane needles so prose that references a SHORTENED form still
 * matches. A project catalogued as "AI Applications Platform with
 * Infrastructure-as-Code" is cited in matcher prose as "AI Applications
 * Platform:" — the full-name substring never matched, which is how a run
 * with project-grounded evidence tallied 0 Projects. Adds:
 *   - the first clause before " with " / " — " / ": " (when >= 2 words)
 *   - for "Company (ABBR)" terms: the paren-stripped base, plus the
 *     abbreviation itself when >= 4 chars (short ones like "AWS" appear in
 *     tech prose everywhere and would over-attribute).
 */
export function expandLaneNeedles(names: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        out.add(name);
        const clause = name.split(/\s+with\s+|\s+—\s+|:\s+/)[0].trim();
        if (clause !== name && clause.split(/\s+/).length >= 2) out.add(clause);
        const paren = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(name);
        if (paren) {
            out.add(paren[1].trim());
            if (paren[2].trim().length >= 4) out.add(paren[2].trim());
        }
    }
    return [...out];
}

/** Evidence-file paths that are resume/career content rather than code. */
const CAREER_FILE_RE = /resume-data|resume_import|user_career|career[-_]history/i;

/**
 * Classify one ledger entry's source lane(s). Deterministic, order-stable
 * (repo, project, career). Returns [] only when nothing can be attributed
 * (e.g. an honest gap with no files and no prose match).
 */
export function classifyLanes(entry: SkillEvidenceEntry, index: LaneIndex): SkillEvidenceLane[] {
    const lanes = new Set<SkillEvidenceLane>();

    // Code files always lead the REPO lane — file-backed evidence is the concrete
    // path, whether or not the repo is also catalogued as a project.
    for (const file of entry.evidenceFiles) {
        if (repoOfFile(file)) {
            lanes.add('repo');
            break;
        }
    }

    // Resume-derived citations (resume-data.ts, career history) are CAREER
    // content that happens to live in a repo — credit the career lane too.
    if (entry.evidenceFiles.some((f) => CAREER_FILE_RE.test(f))) lanes.add('career');

    // Prose adds context: a documented project case study (→ project) and/or a
    // career company/title (→ career). Project is corroboration, never the lead.
    const prose = `${entry.evidence} ${entry.transferableBridge}`;
    if (prose.trim().length > 0) {
        if (mentionsAny(prose, expandLaneNeedles(index.projectNames))) lanes.add('project');
        if (mentionsAny(prose, expandLaneNeedles(index.careerTerms))) lanes.add('career');
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

/**
 * Re-assert the repo lane AFTER the code-evidence pass: an entry that only
 * gained files there (e.g. a transferable bridge citing alternative tech's
 * code) has file-backed proof its pre-strip classification could not see.
 * Never removes a lane — classification ran on the matcher's ORIGINAL
 * citations, which stay honest even where display files were stripped.
 */
export function mergeRepoLane(ledger: readonly SkillEvidenceEntry[]): SkillEvidenceEntry[] {
    return ledger.map((entry) => {
        if (entry.status === 'gap') return entry;
        const hasRepoFile = entry.evidenceFiles.some((f) => repoOfFile(f) !== null);
        if (!hasRepoFile) return entry;
        const lanes = entry.sourceLanes ?? [];
        if (lanes.includes('repo')) return entry;
        return { ...entry, sourceLanes: ['repo', ...lanes] };
    });
}
