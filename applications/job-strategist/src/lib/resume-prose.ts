/**
 * @format
 * Resume prose extractor — turns the Strategist's tailored resume + cover letter
 * into tagged ProseSection[] for BedrockProseLinter. Sibling to coach-prose.ts,
 * but for the resume-generation surfaces (summary, experience highlights, key
 * achievements, project descriptions, cover letter). Short structural fields
 * (titles, dates, names) are skipped — they aren't prose.
 */
import type { StructuredResumeData, ProseSection, ProseRegister } from '@bedrock/shared';

function push(out: ProseSection[], location: string, register: ProseRegister, v: unknown): void {
    if (typeof v === 'string' && v.trim().length > 0) {
        out.push({ location, register, text: v.trim() });
    }
}

export function extractResumeProseSections(
    resume: StructuredResumeData | null,
    coverLetter: string | null,
): ProseSection[] {
    const out: ProseSection[] = [];

    push(out, 'coverLetter', 'narrative', coverLetter);

    if (resume) {
        push(out, 'resume.summary', 'resume-prose', resume.summary);
        resume.experience?.forEach((e, i) =>
            (e.highlights ?? []).forEach((h, j) =>
                push(out, `resume.experience[${i}].highlights[${j}]`, 'resume-prose', h),
            ),
        );
        resume.keyAchievements?.forEach((a, i) =>
            push(out, `resume.keyAchievements[${i}]`, 'resume-prose', a.achievement),
        );
        resume.projects?.forEach((p, i) =>
            push(out, `resume.projects[${i}].description`, 'resume-prose', p.description),
        );
    }

    return out;
}
