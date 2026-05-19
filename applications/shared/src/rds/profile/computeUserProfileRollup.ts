/**
 * @format
 * computeUserProfileRollup — Pure per-user aggregate over repository_profiles.
 *
 * SP0 of the Profile Intelligence initiative. Twin of computeKbQuality:
 * zero I/O, no Bedrock, deterministic. Headline aggregates use only
 * classification='project' && !isHidden && extractionStatus='completed';
 * classificationCounts is computed over ALL input rows so later sub-projects
 * (e.g. Reveal external-contribution) are not blocked by this narrow scope.
 *
 * "Commit volume" is a proxy: Σ per-repo commit_count grouped by the repo's
 * primary_language. Not line-level. methodology.* labels this honestly so
 * downstream LLM copy does not overclaim.
 */

export interface ProfileAggInput {
    readonly repoFullName:     string;
    readonly classification:   string;
    readonly isHidden:         boolean;
    readonly extractionStatus: string;
    readonly primaryLanguage:  string | null;
    readonly commitCount:      number;
    readonly lastActiveAt:     string | null;
    readonly domain:           string;
    readonly complexity:       string;
    readonly roleInferred:     string;
    readonly techStack:        readonly string[];
}

export interface LanguageStat {
    readonly language:          string;
    readonly repoCount:         number;
    readonly commitVolumeProxy: number;
    readonly sharePct:          number;
}
export interface TechStat { readonly tech: string; readonly repoCount: number; }
export interface ActivityArcEntry {
    readonly repoFullName:    string;
    readonly lastActiveAt:    string;
    readonly primaryLanguage: string | null;
    readonly domain:          string;
}

export interface UserProfileRollup {
    readonly version: 1;
    readonly languages: LanguageStat[];
    readonly domains: { readonly counts: Record<string, number>; readonly dominant: string | null };
    readonly complexity: { readonly simple: number; readonly moderate: number; readonly complex: number };
    readonly roles: { readonly creator: number; readonly maintainer: number; readonly contributor: number };
    readonly techStackTop: TechStat[];
    readonly activityArc: ActivityArcEntry[];
    readonly totals: {
        readonly projectRepoCount:       number;
        readonly totalCommitVolumeProxy: number;
        readonly earliestActivity:       string | null;
        readonly latestActivity:         string | null;
        readonly activeYearsApprox:      number;
    };
    readonly classificationCounts: Record<string, number> & { readonly hiddenCount: number };
    readonly methodology: {
        readonly version: 1;
        readonly commitVolume: string;
        readonly domainMix: string;
        readonly scope: string;
        readonly confidence: string;
    };
}

export interface UserProfileRollupResult {
    readonly projectRepoCount:   number;
    readonly totalRepoCount:     number;
    readonly methodologyVersion: number;
    readonly rollup:             UserProfileRollup;
}

const COMPLEXITY_KEYS = ['simple', 'moderate', 'complex'] as const;
const ROLE_KEYS       = ['creator', 'maintainer', 'contributor'] as const;

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

function isQualifying(r: ProfileAggInput): boolean {
    return r.classification === 'project'
        && !r.isHidden
        && r.extractionStatus === 'completed';
}

const METHODOLOGY: UserProfileRollup['methodology'] = {
    version:      1,
    commitVolume: 'primary-language commit-count proxy (not per-line)',
    domainMix:    'repo-count share',
    scope:        'classification=project, !hidden, completed',
    confidence:   'aggregates derived from per-repo profile signals; language ranking is a commit-count proxy, not line-level',
};

export function computeUserProfileRollup(
    rows: readonly ProfileAggInput[],
): UserProfileRollupResult {
    const qualifying = rows.filter(isQualifying);

    const langMap = new Map<string, { repoCount: number; proxy: number }>();
    for (const r of qualifying) {
        const lang = r.primaryLanguage && r.primaryLanguage.length > 0
            ? r.primaryLanguage : 'unknown';
        const e = langMap.get(lang) ?? { repoCount: 0, proxy: 0 };
        e.repoCount += 1;
        e.proxy     += Number.isFinite(r.commitCount) ? r.commitCount : 0;
        langMap.set(lang, e);
    }
    const totalProxy = [...langMap.values()].reduce((s, e) => s + e.proxy, 0);
    const languages: LanguageStat[] = [...langMap.entries()]
        .map(([language, e]) => ({
            language,
            repoCount:         e.repoCount,
            commitVolumeProxy: e.proxy,
            sharePct:          totalProxy > 0 ? round2((e.proxy / totalProxy) * 100) : 0,
        }))
        .sort((a, b) =>
            b.commitVolumeProxy - a.commitVolumeProxy ||
            a.language.localeCompare(b.language));

    const domainCounts: Record<string, number> = {};
    for (const r of qualifying) {
        if (!r.domain) continue;
        domainCounts[r.domain] = (domainCounts[r.domain] ?? 0) + 1;
    }
    let dominant: string | null = null;
    let dominantN = -1;
    for (const [d, n] of Object.entries(domainCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (n > dominantN) { dominant = d; dominantN = n; }
    }

    const complexity = { simple: 0, moderate: 0, complex: 0 };
    const roles      = { creator: 0, maintainer: 0, contributor: 0 };
    for (const r of qualifying) {
        if ((COMPLEXITY_KEYS as readonly string[]).includes(r.complexity)) {
            complexity[r.complexity as (typeof COMPLEXITY_KEYS)[number]] += 1;
        }
        if ((ROLE_KEYS as readonly string[]).includes(r.roleInferred)) {
            roles[r.roleInferred as (typeof ROLE_KEYS)[number]] += 1;
        }
    }

    const techMap = new Map<string, number>();
    for (const r of qualifying) {
        for (const t of r.techStack ?? []) {
            techMap.set(t, (techMap.get(t) ?? 0) + 1);
        }
    }
    const techStackTop: TechStat[] = [...techMap.entries()]
        .map(([tech, repoCount]) => ({ tech, repoCount }))
        .sort((a, b) => b.repoCount - a.repoCount || a.tech.localeCompare(b.tech));

    const dated = qualifying
        .filter(r => r.lastActiveAt != null && r.lastActiveAt.length > 0)
        .sort((a, b) =>
            a.lastActiveAt!.localeCompare(b.lastActiveAt!) ||
            a.repoFullName.localeCompare(b.repoFullName));
    const activityArc: ActivityArcEntry[] = dated.map(r => ({
        repoFullName:    r.repoFullName,
        lastActiveAt:    r.lastActiveAt!,
        primaryLanguage: r.primaryLanguage,
        domain:          r.domain,
    }));
    const earliestActivity = dated.length > 0 ? dated[0].lastActiveAt! : null;
    const latestActivity   = dated.length > 0 ? dated[dated.length - 1].lastActiveAt! : null;
    let activeYearsApprox = 0;
    if (dated.length >= 2 && earliestActivity && latestActivity) {
        const ms = new Date(latestActivity).getTime() - new Date(earliestActivity).getTime();
        activeYearsApprox = round1(ms / (365.25 * 24 * 60 * 60 * 1000));
    }

    const classificationCounts: Record<string, number> & { hiddenCount: number } =
        { hiddenCount: 0 } as Record<string, number> & { hiddenCount: number };
    for (const r of rows) {
        classificationCounts[r.classification] =
            (classificationCounts[r.classification] ?? 0) + 1;
        if (r.isHidden) classificationCounts.hiddenCount += 1;
    }

    const rollup: UserProfileRollup = {
        version: 1,
        languages,
        domains: { counts: domainCounts, dominant },
        complexity,
        roles,
        techStackTop,
        activityArc,
        totals: {
            projectRepoCount:       qualifying.length,
            totalCommitVolumeProxy: totalProxy,
            earliestActivity,
            latestActivity,
            activeYearsApprox,
        },
        classificationCounts,
        methodology: METHODOLOGY,
    };

    return {
        projectRepoCount:   qualifying.length,
        totalRepoCount:     rows.length,
        methodologyVersion: 1,
        rollup,
    };
}
