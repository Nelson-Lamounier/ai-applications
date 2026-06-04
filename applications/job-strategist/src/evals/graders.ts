/** @format */
import type { InterviewCoachResult, SkillCandidateSet, InterviewStage } from '@bedrock/shared';

/** The exact input the coach receives, frozen for grading. */
export interface EvalInput {
    analysisXml: string;
    candidateSets: SkillCandidateSet[];
    stage: InterviewStage;
}

export interface GraderResult {
    grader: string;
    pass: boolean;
    score: number; // 0..1
    failures: string[];
}

export interface GraderReport {
    pass: boolean;
    results: GraderResult[];
}

export type Grader = (input: EvalInput, output: InterviewCoachResult) => GraderResult;

/** Build a GraderResult from a name + failures list. score = pass ? 1 : 0. */
export function mkResult(grader: string, failures: string[]): GraderResult {
    return { grader, pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, failures };
}

/** All candidate evidence ids across the sets (shared by grounding + honesty graders). */
export function allowedIds(sets: readonly SkillCandidateSet[]): Set<string> {
    const s = new Set<string>();
    for (const set of sets) for (const c of set.candidates) s.add(c.id);
    return s;
}

/** All candidate projectIds across the sets. */
export function allowedProjectIds(sets: readonly SkillCandidateSet[]): Set<string> {
    const s = new Set<string>();
    for (const set of sets) for (const c of set.candidates) s.add(c.projectId);
    return s;
}

export function runGraders(graders: Grader[], input: EvalInput, output: InterviewCoachResult): GraderReport {
    const results = graders.map(g => g(input, output));
    return { pass: results.every(r => r.pass), results };
}
