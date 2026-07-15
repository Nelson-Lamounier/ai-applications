/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
    log: () => undefined,
}));
import { runAgent } from '@bedrock/shared';
import type { StructuredResumeData } from '@bedrock/shared';
import { LENGTH_BUDGET, measureResume, hardTrim, applyLengthBudget, resolveModelId } from '../length-budget.js';

const mockRun = runAgent as jest.Mock;

const sentence = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ') + '.';
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const base = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Production AI Systems · LLM Evaluation', email: 'e', location: 'Dublin' },
    summary: 'Ships production AI systems. Five years across cloud and support. Closing metric: 25 ArgoCD apps.',
    experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Cut enrichment cost to near-zero via dedup caching.'] }],
    skills: [{ category: 'AI & LLM Engineering', skills: ['AWS Bedrock', 'RAG pipelines'] }],
    education: [{ degree: 'Higher Diploma in Computing', institution: 'DBS', period: '2022-2024' }],
    certifications: [], projects: [], keyAchievements: [],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
    ...over,
} as StructuredResumeData);

const jd = { requiredSkills: ['RAG', 'Python'], companyProblem: 'production AI delivery', responsibilities: ['ship agentic systems'] };

describe('measureResume', () => {
    it('a compact resume is within budget', () => {
        const m = measureResume(base());
        expect(m.overBudget).toEqual([]);
    });

    it('flags every section over budget (the 2026-07-02 Google shape)', () => {
        const m = measureResume(base({
            summary: sentence(120),
            experience: [{ company: 'F', title: 'E', period: 'p', highlights: [sentence(200), sentence(200), sentence(150)] }],
            skills: [{ category: 'C', skills: [sentence(180)] }],
            projects: [{ name: 'P', description: sentence(200), github: '' }, { name: 'Q', description: sentence(280), github: '' }],
        } as never));
        expect(m.overBudget).toEqual(expect.arrayContaining(['summary', 'experience', 'skills', 'projects', 'total']));
        expect(m.total).toBeGreaterThan(LENGTH_BUDGET.totalWords);
    });
});

describe('hardTrim', () => {
    it('drops skill items beyond the per-category cap and strips prose parentheticals', () => {
        const items = ['prompt caching (a very long parenthetical essay about tools frameworks and everything else in the platform)',
            'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
        // Force the skills section over budget so the trim engages.
        const filler = { category: 'Filler', skills: [sentence(150)] };
        const r = base({ skills: [{ category: 'C', skills: items }, filler] } as never);
        const out = hardTrim(r);
        expect(out.skills[0].skills.length).toBeLessThanOrEqual(LENGTH_BUDGET.maxSkillItemsPerCategory);
        expect(out.skills[0].skills[0]).toBe('prompt caching');
    });

    it('trims project descriptions to whole sentences under the cap', () => {
        const desc = `${sentence(40)} ${sentence(40)} ${sentence(40)}`;
        const r = base({ projects: [{ name: 'P', description: desc, github: '' }, { name: 'Q', description: sentence(150), github: '' }] } as never);
        const out = hardTrim(r);
        const outWords = (out.projects[0].description ?? '').split(/\s+/).length;
        expect(outWords).toBeLessThanOrEqual(LENGTH_BUDGET.perProjectWords + 1);
        expect(out.projects[0].description).toMatch(/\.$/);
    });

    it('caps bullets per role when experience is over budget', () => {
        const highlights = Array.from({ length: 8 }, () => sentence(60));
        const r = base({ experience: [{ company: 'F', title: 'E', period: 'p', highlights }] } as never);
        const out = hardTrim(r);
        expect(out.experience[0].highlights).toHaveLength(LENGTH_BUDGET.maxBulletsPerRole);
    });

    it('a >32-word bullet now SURVIVES hard trim untouched -- the per-bullet cap moved to the agent contract (F7, superseded by Task 2 experience-lock)', () => {
        // Was: hardTrimExperience truncated any surviving bullet over
        // perBulletWords via trimSentences. Task 2 (job-strategist experience
        // e2e-provenance) made Experience agent-owned and BYTE-IDENTICAL once
        // fillResumeExperience has run -- see experience-lock.ts's
        // withExperienceLock, which every run-pipeline.ts downstream pass
        // (including applyLengthBudget/hardTrim) is now wrapped in. A rewrite
        // here would be reverted by that lock anyway, so hardTrimExperience
        // was simplified to whole-bullet slicing only (drop bullets beyond
        // maxBulletsPerRole); the per-bullet word cap is now the Experience
        // agent's own prompt contract (Task 3), not a post-hoc rewrite.
        const shortBullet = 'Cut enrichment cost to near-zero via dedup caching.';
        const longBullet = sentence(91);
        const r = base({
            experience: [{ company: 'F', title: 'E', period: 'p', highlights: [shortBullet, longBullet] }],
            projects: [{ name: 'P', description: sentence(900), github: '' }],
        } as never);
        expect(measureResume(r).overBudget).toContain('total');

        const out = hardTrim(r);

        expect(out.experience[0].highlights).toHaveLength(2);
        // The long bullet survives byte-identical -- no truncation.
        expect(out.experience[0].highlights[1]).toBe(longBullet);
        expect(wordCount(out.experience[0].highlights[1])).toBeGreaterThan(LENGTH_BUDGET.perBulletWords);
        // Short bullet is untouched too -- no needless truncation.
        expect(out.experience[0].highlights[0]).toBe(shortBullet);
    });

    it('trims middle summary sentences, keeping the first and the closing metric', () => {
        const r = base({ summary: `Opening positioning line. ${sentence(60)} ${sentence(60)} Closing metric: 25 ArgoCD apps.` });
        const out = hardTrim(r);
        expect(out.summary.startsWith('Opening positioning line.')).toBe(true);
        expect(out.summary).toContain('Closing metric: 25 ArgoCD apps.');
    });
});

describe('applyLengthBudget', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('within budget → untouched, no LLM call, no violations', async () => {
        const r = base();
        const seen: string[] = [];
        const out = await applyLengthBudget(r, jd, (v) => seen.push(v.code));
        expect(out).toBe(r);
        expect(seen).toEqual([]);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('over budget → condense runs; a compliant condense needs no hard trim', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        const seen: string[] = [];
        const out = await applyLengthBudget(fat, jd, (v) => seen.push(v.code));
        expect(out).toStrictEqual(fixed);
        expect(seen).toEqual(['length_over_budget', 'length_condensed']);
    });

    it('condense fails (fail-open) → deterministic hard trim still bounds the resume', async () => {
        mockRun.mockRejectedValue(new Error('bedrock down'));
        const fat = base({
            skills: [{ category: 'C', skills: Array.from({ length: 12 }, () => sentence(20)) }],
            projects: [{ name: 'P', description: sentence(300), github: '' }],
        } as never);
        const seen: string[] = [];
        const out = await applyLengthBudget(fat, jd, (v) => seen.push(v.code));
        expect(seen).toEqual(expect.arrayContaining(['length_over_budget', 'length_hard_trimmed']));
        const m = measureResume(out);
        expect(m.skills).toBeLessThanOrEqual(measureResume(fat).skills);
        expect(m.projects).toBeLessThanOrEqual(LENGTH_BUDGET.projectsWords);
    });

    it('condense that still exceeds budget gets the hard trim on top', async () => {
        const stillFat = base({ projects: [{ name: 'P', description: sentence(200), github: '' }, { name: 'Q', description: sentence(200), github: '' }] } as never);
        mockRun.mockResolvedValue({ data: stillFat });
        const fat = base({ projects: [{ name: 'P', description: sentence(400), github: '' }] } as never);
        const out = await applyLengthBudget(fat, jd);
        const m = measureResume(out);
        expect(m.projects).toBeLessThanOrEqual(LENGTH_BUDGET.projectsWords + 2);
    });
});

describe('applyLengthBudget — expand direction', () => {
    beforeEach(() => { mockRun.mockReset(); });
    const jdX = { requiredSkills: ['CI/CD'], companyProblem: 'repeatable delivery', responsibilities: ['ship'] };

    it('under-filled resume with grounding → expand fires once', async () => {
        const grown = base({ summary: sentence(90) + ' ' + sentence(90), projects: [{ name: 'P', description: sentence(70), github: '' }] } as never);
        mockRun.mockResolvedValue({ data: grown });
        const thin = base();  // ~30 words total
        const seen: string[] = [];
        const out = await applyLengthBudget(thin, jdX, (v) => seen.push(v.code), { groundingFacts: 'facts' });
        expect(seen).toEqual(expect.arrayContaining(['length_under_filled', 'length_expanded']));
        expect(measureResume(out).total).toBeGreaterThan(measureResume(thin).total);
    });

    it('under-filled WITHOUT grounding → untouched (never expand ungrounded)', async () => {
        const thin = base();
        const out = await applyLengthBudget(thin, jdX);
        expect(out).toBe(thin);
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('thin roles are reported in the measure', () => {
        const m = measureResume(base());
        expect(m.underFilled).toBe(true);
        expect(m.thinRoles).toEqual(['Cloud & DevOps Engineer']);
    });
});

describe('applyLengthBudget — condense self-scrubs its own instruction leaks (F3)', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('strips a length-budget constant (32 = perBulletWords) leaked into a fabricated metric span, ungrounded', async () => {
        const leaked = base({
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Reduced onboarding time by 32% company-wide.'] }],
        } as never);
        mockRun.mockResolvedValue({ data: leaked });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        const out = await applyLengthBudget(fat, jd, () => {});
        expect(out.experience[0].highlights[0]).not.toMatch(/32/);
        expect(out.experience[0].highlights[0]).toContain('company-wide');
    });

    it('keeps the same leaked-looking number when groundingFacts states it', async () => {
        const grounded = base({
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Reduced onboarding time by 32% company-wide.'] }],
        } as never);
        mockRun.mockResolvedValue({ data: grounded });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        const out = await applyLengthBudget(fat, jd, () => {}, { groundingFacts: 'Verified: onboarding time cut 32% after workflow automation.' });
        expect(out.experience[0].highlights[0]).toContain('32%');
    });

    it('scrubEvidenceText grounds the condense scrub WITHOUT authorizing expand', async () => {
        const grounded = base({
            experience: [{ company: 'F', title: 'Cloud & DevOps Engineer', period: '2022 - Present', highlights: ['Reduced onboarding time by 32% company-wide.'] }],
        } as never);
        mockRun.mockResolvedValue({ data: grounded });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        const out = await applyLengthBudget(fat, jd, () => {}, { scrubEvidenceText: 'Verified: onboarding time cut 32% after workflow automation.' });
        expect(out.experience[0].highlights[0]).toContain('32%');
        // Only the mocked condense call fired — no separate expand call.
        expect(mockRun).toHaveBeenCalledTimes(1);
    });
});

describe('condense prompt — project pitch protection (run 9216cf25)', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('the condense system prompt PROTECTS project pitch openings — "cut non-JD content first" made the guard-restored pitches the first casualty on the live run', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        await applyLengthBudget(fat, jd, () => {});
        const config = mockRun.mock.calls[0]![0].config;
        const system = config.systemPrompt.map((b: { text?: string }) => b.text ?? '').join('\n');
        expect(system).toContain('PITCH OPENINGS ARE PROTECTED');
        expect(system).toMatch(/opening sentence/i);
    });
});

describe('resolveModelId (F7, CLAUDE.md §4: Sonnet for nuanced structured generation)', () => {
    it('resolves to the Sonnet id when RESUME_REWRITE_MODEL is unset', () => {
        expect(resolveModelId(undefined)).toBe('eu.anthropic.claude-sonnet-4-6');
    });

    it('resolves to the override id when RESUME_REWRITE_MODEL is set', () => {
        expect(resolveModelId('custom.override.model-id')).toBe('custom.override.model-id');
    });

    it('the condense/expand agent config actually uses the resolved (Sonnet) model id', async () => {
        mockRun.mockReset();
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const fat = base({ projects: [{ name: 'P', description: sentence(300), github: '' }] } as never);
        await applyLengthBudget(fat, jd, () => {});
        const config = mockRun.mock.calls[0]![0].config;
        expect(config.modelId).toBe(resolveModelId(undefined));
    });
});
