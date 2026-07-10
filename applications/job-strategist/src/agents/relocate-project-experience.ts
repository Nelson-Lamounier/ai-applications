/**
 * @format
 * Deterministic post-writer fix: keep the Experience section to REAL employment
 * and move any project the writer mis-filed there into projects[].highlights.
 *
 * With per-angle project bullets available, the writer sometimes spawns
 * "Solo <role> — <Project>" Experience entries (period "Project") to carry those
 * bullets — inventing job titles, over-splitting one project into several, and
 * leaving projects[].highlights empty (observed live: ServiceNow SRE run
 * 234c1afe). Experience must contain ONLY the verified career-history employers;
 * project work belongs in the Projects section with its github link.
 *
 * An Experience entry is a mis-filed project when its company is NOT one of the
 * verified employers. Each such stray is routed to a project by name, else by
 * the best content overlap of its highlights against the project's known
 * tailored bullets (the strays are derived from those, so overlap is decisive),
 * else against the project's name+description. Highlights are appended
 * (de-duplicated, order preserved). Fail-safe: with no projects to receive a
 * stray, or no verified employers to compare against, the resume is returned
 * unchanged.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { ProjectResumeBulletSet } from './project-evidence-block.js';

type Resume = StructuredResumeData;
type Experience = Resume['experience'][number];

/** Lowercased alphanumeric words, for loose company/name matching. */
function norm(s: string | undefined): string {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Content tokens (>= 4 chars) for overlap scoring. */
function tokens(s: string): Set<string> {
    return new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n;
}

/** Loose match of a company against the verified-employer name set. */
function matchesEmployer(company: string | undefined, employerNorms: readonly string[]): boolean {
    const c = norm(company);
    if (!c) return false;
    return employerNorms.some((e) =>
        c === e || (e.length >= 5 && c.includes(e)) || (c.length >= 5 && e.includes(c)),
    );
}

/** Index of the project a stray experience entry belongs to: by name, else bullet overlap. */
function pickTargetProject(
    entry: Experience,
    projectNames: readonly string[],
    projTokens: ReadonlyArray<Set<string>>,
): number {
    const company = norm(entry.company);
    const label = norm(`${entry.company ?? ''} ${entry.title ?? ''}`);
    const byName = projectNames.findIndex((pn) =>
        pn.length > 0 && (label.includes(pn) || (company.length >= 5 && pn.includes(company))),
    );
    if (byName >= 0) return byName;
    const hlTok = tokens((entry.highlights ?? []).join(' '));
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < projTokens.length; i++) {
        const score = overlap(hlTok, projTokens[i]);
        if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
}

type MutableProject = Resume['projects'][number] & { highlights: string[] };

/** Per-project token sets: prefer the tailored bullets, fall back to name + description. */
function buildProjectTokens(
    projects: ReadonlyArray<MutableProject>,
    projectBullets: ReadonlyArray<ProjectResumeBulletSet>,
): Set<string>[] {
    const byName = new Map<string, Set<string>>();
    for (const s of projectBullets) byName.set(norm(s.name), tokens(s.bullets.join(' ')));
    return projects.map((p) => {
        const fromBullets = byName.get(norm(p.name));
        return fromBullets && fromBullets.size > 0 ? fromBullets : tokens(`${p.name} ${p.description ?? ''}`);
    });
}

/** Append an entry's highlights to a project, de-duplicated + order-preserving. */
function mergeHighlights(target: MutableProject, entry: Experience): void {
    const seen = new Set(target.highlights.map((h) => norm(h)));
    for (const hl of entry.highlights ?? []) {
        const key = norm(hl);
        if (key && !seen.has(key)) { target.highlights.push(hl); seen.add(key); }
    }
}

export function relocateProjectExperience(
    resume: Resume,
    verifiedEmployers: ReadonlyArray<{ name: string }>,
    projectBullets: ReadonlyArray<ProjectResumeBulletSet> = [],
): Resume {
    const projects: MutableProject[] = (resume.projects ?? []).map((p) => ({ ...p, highlights: [...(p.highlights ?? [])] }));
    const employerNorms = verifiedEmployers.map((e) => norm(e.name)).filter((n) => n.length > 0);
    // Without a roster to compare against, or no projects to receive strays,
    // relocation is unsafe — leave the resume untouched.
    if (projects.length === 0 || employerNorms.length === 0) return resume;

    const kept: Experience[] = [];
    const strays: Experience[] = [];
    for (const e of resume.experience ?? []) {
        (matchesEmployer(e.company, employerNorms) ? kept : strays).push(e);
    }
    if (strays.length === 0) return resume;

    const projectNames = projects.map((p) => norm(p.name));
    const projTokens = buildProjectTokens(projects, projectBullets);
    for (const e of strays) mergeHighlights(projects[pickTargetProject(e, projectNames, projTokens)], e);

    return { ...resume, experience: kept, projects };
}
