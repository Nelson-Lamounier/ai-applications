/** @format */
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

export const JUDGE_AXES = ['narrative-faithfulness', 'stage-focus', 'hallucination-scan'] as const;
export type JudgeAxis = (typeof JUDGE_AXES)[number];

export interface JudgeVerdict {
    axis: JudgeAxis;
    pass: boolean;
    score: number; // 0..1
    reasoning: string;
}

/** Forced-tool schema the judge model must satisfy. */
export const JUDGE_TOOL = {
    name: 'emit_judge_verdicts',
    description: 'Emit one verdict per subjective coaching axis.',
    inputSchema: {
        type: 'object',
        properties: {
            verdicts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        axis: { type: 'string', enum: [...JUDGE_AXES] },
                        pass: { type: 'boolean' },
                        score: { type: 'number' },
                        reasoning: { type: 'string' },
                    },
                    required: ['axis', 'pass', 'score', 'reasoning'],
                    additionalProperties: false,
                },
            },
        },
        required: ['verdicts'],
        additionalProperties: false,
    },
} as const;

/** Build the judge user prompt for one fixture's output. */
export function buildJudgePrompt(input: EvalInput, output: InterviewCoachResult): string {
    return [
        `You are grading an interview-coaching brief for the "${input.stage}" stage.`,
        `Judge ONLY these axes, one verdict each: ${JUDGE_AXES.join(', ')}.`,
        `- narrative-faithfulness: does each skillTransfer narrative follow from its cited evidence, with no embellishment?`,
        `- stage-focus: is the content genuinely right for this stage?`,
        `- hallucination-scan: any claim not traceable to the analysis or candidate evidence?`,
        ``,
        `## Analysis`,
        input.analysisXml,
        ``,
        `## Coaching output (JSON)`,
        JSON.stringify(output, null, 2),
        ``,
        `Call emit_judge_verdicts with one verdict per axis.`,
    ].join('\n');
}

/** Make a string safe for a single markdown table cell. */
function cell(s: string): string {
    return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** Render verdicts as a markdown report. */
export function formatReport(fixtureName: string, verdicts: JudgeVerdict[]): string {
    const rows = verdicts.map(
        v => `| ${v.axis} | ${v.pass ? 'PASS' : 'FAIL'} | ${v.score.toFixed(2)} | ${cell(v.reasoning)} |`,
    );
    return [
        `### Tier 2 judge — ${fixtureName}`,
        ``,
        `| axis | result | score | reasoning |`,
        `| --- | --- | --- | --- |`,
        ...rows,
    ].join('\n');
}
