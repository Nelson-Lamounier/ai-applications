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
    readonly compTarget: string | null;
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
    const [expectation, comp, gapTemplates] = await Promise.all([
        repo.getStageExpectation(companyType, args.roleFamily, args.stage),
        repo.getCompBenchmark(args.roleFamily, args.seniority, args.region),
        repo.listScaffolds('gap_handling'),
    ]);
    return {
        expectation,
        processShape: profile?.processShape ?? [],
        comp,
        gapTemplates,
        compTarget: args.compTarget,
    };
}

const TRUTHFULNESS =
    'Calibration changes emphasis, never truthfulness. Ground every point in the candidate’s ' +
    'verified evidence; omit anything you cannot ground.';

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

    lines.push(TRUTHFULNESS);
    return lines.join('\n');
}
