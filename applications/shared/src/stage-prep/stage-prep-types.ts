/** @format */

/** Company archetype dimension used by stage_expectations + company profiles. */
export type CompanyType = 'faang' | 'scaleup' | 'series-b' | 'enterprise' | '*';

/** Role family dimension for stage_expectations + comp_benchmarks. */
export type RoleFamily = 'backend' | 'frontend' | 'devops' | 'ml' | 'data' | 'mobile' | '*';

/** Compensation seniority enum (adds 'principal' above the project StageId set). */
export type CompSeniority = 'junior' | 'mid' | 'senior' | 'staff' | 'principal';

export interface QuestionPattern {
    readonly type: string;
    readonly promptHint: string;
}

export interface StageExpectation {
    readonly id: string;
    readonly companyType: string;
    readonly roleFamily: string;
    readonly stage: string;
    readonly focusAreas: string[];
    readonly questionPatterns: QuestionPattern[];
    readonly expectationNote: string | null;
}

export interface LeadershipPrinciple {
    readonly name: string;
    readonly description: string;
}

export interface ProcessStage {
    readonly stage: string;
    readonly format: string;
    readonly note: string;
    readonly round_type?: 'dsa' | 'practical' | 'take-home' | 'system-design' | 'behavioural' | 'mixed';
}

export interface CompanyInterviewProfile {
    readonly companyKey: string;
    readonly displayName: string;
    readonly companyType: string;
    readonly leadershipPrinciples: LeadershipPrinciple[];
    readonly processShape: ProcessStage[];
    readonly valuesTaxonomy: LeadershipPrinciple[];
}

export type ScaffoldKind = 'story_scaffold' | 'gap_handling';

export interface PrepScaffold {
    readonly id: string;
    readonly kind: ScaffoldKind;
    readonly title: string;
    readonly structure: Record<string, unknown>;
}

export interface CompBenchmark {
    readonly id: string;
    readonly roleFamily: string;
    readonly seniority: CompSeniority;
    readonly region: string;
    readonly currency: string;
    readonly rangeMin: number;
    readonly rangeP50: number;
    readonly rangeMax: number;
}
