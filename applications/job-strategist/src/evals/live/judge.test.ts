/** @format */
import { JUDGE_AXES, buildJudgePrompt, JUDGE_TOOL, formatReport } from './judge.js';
import type { EvalInput } from '../graders.js';
import type { InterviewCoachResult } from '@bedrock/shared';

const input = { analysisXml: '<a/>', candidateSets: [], stage: 'technical-1' } as unknown as EvalInput;
const output = { stage: 'technical-1', coachingNotes: 'n' } as unknown as InterviewCoachResult;

describe('judge scaffold', () => {
    it('exposes the three subjective axes', () => {
        expect(JUDGE_AXES).toEqual(['narrative-faithfulness', 'stage-focus', 'hallucination-scan']);
    });
    it('buildJudgePrompt embeds the stage and the output JSON', () => {
        const p = buildJudgePrompt(input, output);
        expect(p).toContain('technical-1');
        expect(p).toContain('coachingNotes');
        expect(p).toContain('narrative-faithfulness');
    });
    it('JUDGE_TOOL requires per-axis verdicts', () => {
        expect(JUDGE_TOOL.inputSchema.required).toContain('verdicts');
    });
    it('formatReport renders a markdown table with pass/fail', () => {
        const md = formatReport('technical', [
            { axis: 'stage-focus', pass: true, score: 1, reasoning: 'ok' },
        ]);
        expect(md).toContain('| stage-focus |');
        expect(md).toContain('technical');
    });
    it('formatReport escapes pipes and newlines in reasoning', () => {
        const md = formatReport('technical', [
            { axis: 'stage-focus', pass: false, score: 0, reasoning: 'has | pipe\nand newline' },
        ]);
        expect(md).toContain('has \\| pipe and newline');
        expect(md.split('\n').filter(l => l.startsWith('| stage-focus'))).toHaveLength(1);
    });
});
