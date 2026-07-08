/**
 * @format
 * Experience-roster reconciliation — deterministic, post-writer.
 *
 * The career history is the identity ground truth for the experience section:
 * every resume entry must map onto exactly ONE career entry. Run 30fe4f66
 * (2026-07-08) split the single "Freelance | Cloud & DevOps Engineer" career
 * role into two entries — the career company AND an invented company label —
 * shipping the same job twice; earlier runs silently rebranded the company.
 * Neither #442's content-fidelity guard (per-entry prose grounding) nor
 * preserveExperienceRoster (protects the WRITER's roster across rewrites)
 * anchors the roster to career truth — this module does.
 *
 * Rules:
 * - Two entries anchored to the same career role are MERGED (first keeps its
 *   bullet order, second's bullets append, capped at the persona's 5/role).
 * - An anchored entry's company is restored to the career-history value
 *   verbatim (a company NAME is a fact, not tailoring surface).
 * - Entries that anchor to nothing are KEPT — never silently drop a job.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { CareerEntry } from '../agents/career-history.js';

const MAX_HIGHLIGHTS_PER_ROLE = 5;

type ExperienceEntry = StructuredResumeData['experience'][number];

/** Lowercase word tokens (dashes/diacritics-insensitive enough for anchoring). */
function tokens(s: string): Set<string> {
    return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1));
}

/** Jaccard-ish overlap: |A∩B| / |smaller set|. */
function overlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let hit = 0;
    for (const t of a) if (b.has(t)) hit++;
    return hit / Math.min(a.size, b.size);
}

/**
 * Index of the career entry this resume entry belongs to, or -1.
 * Anchor = strong title overlap AND compatible period (title is the writer's
 * most stable field; the company is exactly what the writer gets wrong).
 */
function anchorIndex(e: ExperienceEntry, career: ReadonlyArray<CareerEntry>): number {
    const title = tokens(e.title ?? '');
    const period = tokens(e.period ?? '');
    let best = -1;
    let bestScore = 0;
    career.forEach((c, i) => {
        const t = overlap(title, tokens(c.title));
        const p = overlap(period, tokens(c.period));
        const score = t * 0.7 + p * 0.3;
        if (t >= 0.6 && score > bestScore) {
            best = i;
            bestScore = score;
        }
    });
    return best;
}

export interface RosterReconcileResult {
    readonly resume: StructuredResumeData;
    /** Violation codes for observability ([] when the roster was faithful). */
    readonly violations: string[];
}

interface RosterState {
    readonly violations: string[];
    readonly byAnchor: Map<number, ExperienceEntry>;
    readonly out: ExperienceEntry[];
}

/** Place one writer entry into the reconciled roster (merge / restore / keep). */
function placeEntry(e: ExperienceEntry, anchor: number, career: ReadonlyArray<CareerEntry>, state: RosterState): void {
    const existing = state.byAnchor.get(anchor);
    if (existing) {
        // Same career role emitted twice — merge bullets into the first entry.
        const merged = [...(existing.highlights ?? []), ...(e.highlights ?? [])].slice(0, MAX_HIGHLIGHTS_PER_ROLE);
        const replacement = { ...existing, highlights: merged };
        state.byAnchor.set(anchor, replacement);
        state.out[state.out.indexOf(existing)] = replacement;
        state.violations.push('experience_roster_duplicate_merged');
        return;
    }
    const careerCompany = career[anchor]!.company;
    let entry = e;
    if ((e.company ?? '').trim() !== careerCompany.trim()) {
        entry = { ...e, company: careerCompany };
        state.violations.push('experience_company_restored');
    }
    state.byAnchor.set(anchor, entry);
    state.out.push(entry);
}

/**
 * Anchor every experience entry to the career history; merge duplicates of
 * the same role and restore career company names. Pure + deterministic;
 * returns the INPUT object untouched when the roster is already faithful.
 */
export function reconcileExperienceRoster(
    resume: StructuredResumeData,
    career: ReadonlyArray<CareerEntry>,
): RosterReconcileResult {
    if (career.length === 0 || !Array.isArray(resume.experience) || resume.experience.length === 0) {
        return { resume, violations: [] };
    }

    const state: RosterState = { violations: [], byAnchor: new Map(), out: [] };
    for (const e of resume.experience) {
        const anchor = anchorIndex(e, career);
        if (anchor === -1) state.out.push(e);
        else placeEntry(e, anchor, career, state);
    }

    if (state.violations.length === 0) return { resume, violations: [] };
    return { resume: { ...resume, experience: state.out }, violations: state.violations };
}
