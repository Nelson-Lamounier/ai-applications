/** @format */
import type { UserProfileRollup } from '../profile/computeUserProfileRollup.js';
import type { MirrorJson, RevealJson, DirectionJson, ReconciliationJson } from '../interfaces/IUserProfileRollupRepository.js';
import type { DiagnosticInputs } from '../interfaces/IDiagnosticInputsReadRepository.js';

export type ComponentKey =
    | 'profileDepth' | 'ragDepth' | 'directionConfidence'
    | 'reconciliationAlignment' | 'resumeCoverage';

export interface ComponentSubScore {
    readonly score:    number;
    readonly blockers: ReadonlyArray<string>;
}

export interface DiagnosticComputed {
    readonly overall:    number;
    readonly components: Readonly<Record<ComponentKey, ComponentSubScore>>;
    readonly methodology: {
        readonly version: 1;
        readonly weights: Readonly<Record<ComponentKey, number>>;
        readonly notes:   string;
    };
}

export interface DiagnosticComputeInput {
    readonly rollup:           UserProfileRollup;
    readonly mirror:           MirrorJson | null;
    readonly reveal:           RevealJson | null;
    readonly direction:        DirectionJson | null;
    readonly reconciliation:   ReconciliationJson | null;
    readonly diagnosticInputs: DiagnosticInputs;
}

// Equal-weight v1: each component contributes up to 20 to the overall /100.
// Retunable as a one-commit constant change.
export const WEIGHTS: Readonly<Record<ComponentKey, number>> = {
    profileDepth:            20,
    ragDepth:                20,
    directionConfidence:     20,
    reconciliationAlignment: 20,
    resumeCoverage:          20,
};

// Threshold for the kb_quality_score (NUMERIC(4,2) in 0..1 on repo_sync_state).
// Retunable; the persisted field name (`reposWithHighKbScore`) is intentionally
// threshold-agnostic.
export const KB_SCORE_THRESHOLD = 0.6;

const clamp01_100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const trunc80     = (s: string) => (s.length <= 80 ? s : s.slice(0, 77) + '…');

function scoreProfileDepth(input: DiagnosticComputeInput): ComponentSubScore {
    const { rollup, mirror, reveal } = input;
    const langs = (rollup.languages ?? []).filter(l => (l.sharePct ?? 0) >= 5);
    // Language diversity 1→3 maps to 0..60 (≥3 → 60).
    const langDiv = Math.min(60, Math.max(0, langs.length) * 20);
    // projectRepoCount 1→10 maps to 0..20.
    const repos = rollup.totals?.projectRepoCount ?? 0;
    const reposPart = Math.min(20, Math.round((Math.min(10, Math.max(0, repos)) / 10) * 20));
    const mirrorPart = mirror ? 10 : 0;
    const revealPart = (reveal?.reveals?.length ?? 0) > 0 ? 10 : 0;
    const score = clamp01_100(langDiv + reposPart + mirrorPart + revealPart);
    const blockers: string[] = [];
    if (langs.length === 0) blockers.push('No language with share ≥5%');
    if (repos < 3)          blockers.push('<3 project repos');
    if (!mirror)            blockers.push('Mirror not yet generated');
    return { score, blockers: blockers.slice(0, 2) };
}

function scoreRagDepth(input: DiagnosticComputeInput): ComponentSubScore {
    const { kbStats } = input.diagnosticInputs;
    const depthRatio = kbStats.projectRepoCount === 0 ? 0 : kbStats.reposWithHighKbScore / kbStats.projectRepoCount;
    const depthPart  = Math.min(60, Math.round(depthRatio * 60));
    const retrPart   = kbStats.avgRetrievalScore == null ? 0 : Math.round(Math.max(0, Math.min(1, kbStats.avgRetrievalScore)) * 40);
    const score = clamp01_100(depthPart + retrPart);
    const blockers: string[] = [];
    if (kbStats.reposWithHighKbScore === 0) blockers.push('No project repos with high KB quality');
    if (kbStats.avgRetrievalScore == null)  blockers.push('Retrieval probe has not run yet');
    return { score, blockers: blockers.slice(0, 2) };
}

function scoreDirectionConfidence(input: DiagnosticComputeInput): ComponentSubScore {
    const d = input.direction;
    if (!d) return { score: 0, blockers: ['Direction not yet generated'] };
    const hasStrong = d.archetypes.some(a => a.fit === 'strong');
    const hasSeniority = (d.seniority?.length ?? 0) > 0;
    const enoughArchetypes = d.archetypes.length >= 3;
    const score = clamp01_100((hasStrong ? 60 : 0) + (hasSeniority ? 20 : 0) + (enoughArchetypes ? 20 : 0));
    const blockers: string[] = [];
    if (!hasStrong)    blockers.push("No grounded archetype with fit='strong'");
    if (!hasSeniority) blockers.push('No seniority calibration yet');
    return { score, blockers: blockers.slice(0, 2) };
}

function scoreReconciliationAlignment(input: DiagnosticComputeInput): ComponentSubScore {
    if (!input.diagnosticInputs.resumePresent) return { score: 0, blockers: ['Résumé not imported'] };
    const rc = input.reconciliation;
    if (!rc) return { score: 50, blockers: ['Reconciliation has not run on this résumé yet'] };
    const unsupported = rc.unsupportedClaims.length;
    const penalty = Math.min(80, unsupported * 10);
    const score = clamp01_100(100 - penalty);
    const blockers: string[] = [];
    if (unsupported > 0) blockers.push(trunc80(rc.unsupportedClaims[0]!.claim));
    if (unsupported > 1) blockers.push(trunc80(rc.unsupportedClaims[1]!.claim));
    return { score, blockers: blockers.slice(0, 2) };
}

function scoreResumeCoverage(input: DiagnosticComputeInput): ComponentSubScore {
    const { resumePresent, resumeEntryCounts: c } = input.diagnosticInputs;
    if (!resumePresent) return { score: 0, blockers: ['Résumé not imported'] };
    let score = 0;
    if (c.experience >= 1) score += 25;
    if (c.experience >= 3) score += 25;
    if (c.skills     >= 1) score += 25;
    if (c.projects   >= 1) score += 25;
    const blockers: string[] = [];
    if (c.experience === 0) blockers.push('No experience entries');
    if (c.skills     === 0) blockers.push('No skills entries');
    if (c.projects   === 0) blockers.push('No project entries');
    return { score: clamp01_100(score), blockers: blockers.slice(0, 2) };
}

export function computeUserDiagnostic(input: DiagnosticComputeInput): DiagnosticComputed {
    const components = {
        profileDepth:            scoreProfileDepth(input),
        ragDepth:                scoreRagDepth(input),
        directionConfidence:     scoreDirectionConfidence(input),
        reconciliationAlignment: scoreReconciliationAlignment(input),
        resumeCoverage:          scoreResumeCoverage(input),
    } satisfies Record<ComponentKey, ComponentSubScore>;
    const sum = (Object.keys(WEIGHTS) as ComponentKey[])
        .reduce((acc, k) => acc + WEIGHTS[k] * components[k].score / 100, 0);
    const overall = clamp01_100(sum);
    return {
        overall,
        components,
        methodology: {
            version: 1,
            weights: WEIGHTS,
            notes: 'Equal-weight v1: each component contributes up to 20. Sub-scores are integer 0..100; overall is rounded.',
        },
    };
}
