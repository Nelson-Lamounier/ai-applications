/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

import { buildAtsCheck } from '../../ats/checks.js';
import { parsePdfBack } from '../../ats/parse-back.js';
import { renderResumePdf } from '../../render/render-resume-pdf.js';

export interface AtsGraderResult {
    grader: string;
    pass: boolean;
    score: number;
    failures: string[];
}

/** Render → parse-back → assert. The eval-suite QA gate for generated resumes. */
export async function gradeResumeAts(
    data: StructuredResumeData,
    jd: { jdMustHaves: string[]; groundedTerms: Set<string> },
): Promise<AtsGraderResult> {
    const buf = await renderResumePdf(data);
    const { text, sections } = await parsePdfBack(buf);
    const check = buildAtsCheck({
        text, sections,
        profile: { name: data.profile.name, email: data.profile.email },
        jdMustHaves: jd.jdMustHaves, groundedTerms: jd.groundedTerms,
    });
    return { grader: 'ats', pass: check.passed, score: check.passed ? 1 : 0, failures: check.issues };
}
