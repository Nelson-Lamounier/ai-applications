/** @format */
import type {
    StageExpectation, ProcessStage, CompBenchmark, PrepScaffold, ScaffoldKind,
    CompanyInterviewProfile,
} from './stage-prep-types.js';

/** Reader surface this module needs — RdsStagePrepOntologyRepository satisfies it structurally. */
export interface StagePrepOntologyReader {
    getStageExpectation(companyType: string, roleFamily: string, stage: string): Promise<StageExpectation | null>;
    getCompanyProfile(companyKey: string): Promise<CompanyInterviewProfile | null>;
    getCompBenchmark(roleFamily: string, seniority: string, region: string): Promise<CompBenchmark | null>;
    listScaffolds(kind: ScaffoldKind): Promise<PrepScaffold[]>;
}

/** Resolved ontology data for one stage-prep run. */
export interface StagePrepConstraints {
    readonly expectation: StageExpectation | null;
    readonly processShape: ProcessStage[];
    readonly comp: CompBenchmark | null;
    readonly gapTemplates: PrepScaffold[];
    readonly storyScaffolds: PrepScaffold[];   // STAR-style story STRUCTURES (filled from real evidence)
    readonly compTarget: string | null;
    readonly dsaTopics?: string[];   // display names of JD-implied DSA topics
    readonly roundType?: string;     // technical round_type for the company
}

/** Normalise a free-text company name to a profile lookup key. */
export function normalizeCompanyKey(company: string): string {
    return company.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fetch all ontology constraints for a stage-prep run. companyType is read from
 * the company profile (falls back to '*' when the company is unknown).
 */
export async function loadStagePrepConstraints(
    repo: StagePrepOntologyReader,
    args: {
        targetCompany: string;
        roleFamily: string;
        stage: string;
        seniority: string;
        region: string;
        compTarget: string | null;
    },
): Promise<StagePrepConstraints> {
    const profile = await repo.getCompanyProfile(normalizeCompanyKey(args.targetCompany));
    const companyType = profile?.companyType ?? '*';
    const [expectation, comp, gapTemplates, storyScaffolds] = await Promise.all([
        repo.getStageExpectation(companyType, args.roleFamily, args.stage),
        repo.getCompBenchmark(args.roleFamily, args.seniority, args.region),
        repo.listScaffolds('gap_handling'),
        repo.listScaffolds('story_scaffold'),
    ]);
    const relevantStage =
        profile?.processShape.find(s => s.stage === args.stage)
        ?? (args.stage.startsWith('technical')
                ? profile?.processShape.find(s => s.stage.startsWith('technical'))
                : undefined);
    return {
        expectation,
        processShape: profile?.processShape ?? [],
        comp,
        gapTemplates,
        storyScaffolds,
        compTarget: args.compTarget,
        roundType: relevantStage?.round_type ?? undefined,
    };
}

const TRUTHFULNESS =
    'Calibration changes emphasis, never truthfulness. Ground every point in the candidate’s ' +
    'verified evidence; omit anything you cannot ground.';

/** Round-type-specific prep emphasis for the DevOps/AI round shapes (S5). Generic guidance only. */
const ROUND_TYPE_GUIDANCE: Record<string, string> = {
    'architecture-review':
        'For an architecture-review round, be ready to walk a system the candidate built end-to-end: ' +
        'starting context, key decisions, tradeoffs, outcomes, and what they would change.',
    'troubleshooting':
        'For a troubleshooting round, expect incident-style debugging: log/metric analysis, ' +
        'hypothesis → isolate → fix, and an on-call/postmortem narrative.',
    'hands-on-lab':
        'For a hands-on-lab round, expect a time-boxed exercise (build/debug/eval); ' +
        'prioritise a working, tested, explainable result over cleverness.',
};

/** Render the resolved constraints into a soft calibration block for the Coach user message. */
export function buildStagePrepConstraintBlock(c: StagePrepConstraints): string {
    const lines: string[] = ['## Stage-prep calibration (structural constraints)'];

    if (c.expectation) {
        if (c.expectation.focusAreas.length) {
            lines.push(`Focus areas this stage typically tests: ${c.expectation.focusAreas.join(', ')}.`);
        }
        if (c.expectation.questionPatterns.length) {
            const types = c.expectation.questionPatterns.map(q => q.type).join(', ');
            lines.push(`Common question types: ${types}.`);
        }
        if (c.expectation.expectationNote) lines.push(c.expectation.expectationNote);
    }

    if (c.processShape.length) {
        const steps = c.processShape.map(s => `${s.stage} (${s.format})`).join(' → ');
        lines.push(`Typical process for this company: ${steps}.`);
    }

    if (c.compTarget || c.comp) {
        const parts: string[] = [];
        if (c.compTarget) parts.push(`Candidate's target: ${c.compTarget}.`);
        if (c.comp) {
            parts.push(
                `Market compensation (${c.comp.currency}, ${c.comp.region}, ${c.comp.seniority}): ` +
                `${c.comp.rangeMin}–${c.comp.rangeMax}, median ${c.comp.rangeP50}.`,
            );
        }
        lines.push(`Compensation context: ${parts.join(' ')}`);
    }

    if (c.gapTemplates.length) {
        const titles = c.gapTemplates.map(g => g.title).join('; ');
        lines.push(`When the candidate has an evidence gap on a topic, use a gap-handling approach (${titles}).`);
    }

    if (c.storyScaffolds.length) {
        const titles = c.storyScaffolds.map(s => s.title).join('; ');
        lines.push(`Story structures the candidate can borrow (fill with their OWN verified evidence — never fabricate): ${titles}.`);
    }

    if (c.roundType) lines.push(`This interview round's type: ${c.roundType}.`);
    if (c.roundType && ROUND_TYPE_GUIDANCE[c.roundType]) lines.push(ROUND_TYPE_GUIDANCE[c.roundType]);
    if (c.dsaTopics && c.dsaTopics.length) {
        lines.push(`DSA topics this role likely tests (calibrated from the JD): ${c.dsaTopics.join(', ')}. ` +
            `Coach honestly: surface the candidate's real-work patterns where they exist; for gaps, recommend external practice (LeetCode/NeetCode) rather than fabricating competence.`);
    }

    lines.push(TRUTHFULNESS);
    return lines.join('\n');
}
