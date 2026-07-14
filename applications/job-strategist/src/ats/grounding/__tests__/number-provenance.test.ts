/** @format */
import { extractNumbers, stripUngroundedNumbers, stripInstructionMetrics } from '../number-provenance.js';
import type { StructuredResumeData } from '@bedrock/shared';

const resume = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Platform Engineer', email: 'n@x.com', location: 'Dublin' },
    summary: 'I build production platforms.',
    experience: [{ company: 'Acme', title: 'Engineer', period: '2020-2024', highlights: ['Built CI/CD'] }],
    skills: [{ category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'BSc Computing', institution: 'TU Dublin', period: '2018-2022' }],
    certifications: [],
    projects: [],
    keyAchievements: [],
    ...over,
});

const withHighlight = (h: string, over: Partial<StructuredResumeData> = {}): StructuredResumeData =>
    resume({ experience: [{ company: 'Acme', title: 'Engineer', period: '2020-2024', highlights: [h] }], ...over });

describe('extractNumbers', () => {
    it('extracts integers and decimals', () => {
        expect(extractNumbers('cut cost 90% across 4 systems in 2.5 weeks')).toEqual(new Set([90, 4, 2.5]));
    });

    it('a range "10-20" yields both 10 and 20', () => {
        expect(extractNumbers('10-20 hrs/week')).toEqual(new Set([10, 20]));
    });

    it('"90%" → {90}, "3+" → {3}', () => {
        expect(extractNumbers('90%')).toEqual(new Set([90]));
        expect(extractNumbers('3+')).toEqual(new Set([3]));
    });

    it('no numbers → empty set', () => {
        expect(extractNumbers('built scalable platforms')).toEqual(new Set());
    });
});

describe('stripUngroundedNumbers', () => {
    it('strips an ungrounded number, keeps a grounded one', () => {
        const r = withHighlight('cut cost ~90% across 4 systems');
        const out = stripUngroundedNumbers(r, new Set([4]));
        const h = out.experience[0].highlights[0];
        expect(h).not.toMatch(/90/);
        expect(h).toMatch(/4 systems/);
        expect(h).toContain('cut cost');
    });

    it('all numbers grounded → resume unchanged', () => {
        const r = withHighlight('cut cost ~90% across 4 systems');
        const out = stripUngroundedNumbers(r, new Set([90, 4]));
        expect(out.experience[0].highlights[0]).toBe('cut cost ~90% across 4 systems');
    });

    it('range "10-20 hrs/week" with allowed {10,20} → kept', () => {
        const r = withHighlight('saved 10-20 hrs/week');
        const out = stripUngroundedNumbers(r, new Set([10, 20]));
        expect(out.experience[0].highlights[0]).toContain('10-20');
    });

    it('range "10-20 hrs/week" with allowed {} → both stripped', () => {
        const r = withHighlight('saved 10-20 hrs/week of toil');
        const out = stripUngroundedNumbers(r, new Set<number>());
        const h = out.experience[0].highlights[0];
        expect(h).not.toMatch(/\d/);
    });

    it('scrubs the summary too', () => {
        const r = resume({ summary: 'Engineer who cut latency 50% and shipped 12 services' });
        const out = stripUngroundedNumbers(r, new Set<number>());
        expect(out.summary).not.toMatch(/\d/);
    });

    it('scrubs keyAchievements too', () => {
        const r = resume({ keyAchievements: [{ achievement: 'Reduced costs by 40% over 3 quarters' }] });
        const out = stripUngroundedNumbers(r, new Set<number>());
        expect(out.keyAchievements[0].achievement).not.toMatch(/\d/);
    });

    it('GUARANTEE: no number outside allowed survives anywhere', () => {
        const r = resume({
            summary: 'cut latency 50% across 8 regions',
            experience: [{ company: 'Acme', title: 'Eng', period: '2020-2024', highlights: ['scaled to 1000 users, 99.9% uptime over 200 days'] }],
            keyAchievements: [{ achievement: 'shipped 12 apps in 6 months' }],
        });
        const allowed = new Set([8]);
        const out = stripUngroundedNumbers(r, allowed);
        const all = [out.summary, ...out.experience.flatMap(e => e.highlights), ...out.keyAchievements.map(a => a.achievement)].join(' ');
        for (const n of extractNumbers(all)) {
            expect(allowed.has(n)).toBe(true);
        }
    });

    it('is idempotent', () => {
        const r = withHighlight('cut cost ~90% across 4 systems');
        const once = stripUngroundedNumbers(r, new Set([4]));
        const twice = stripUngroundedNumbers(once, new Set([4]));
        expect(twice).toStrictEqual(once);
    });

    it('tidies punctuation and whitespace', () => {
        const r = withHighlight('Delivered 5 projects, mentored team');
        const out = stripUngroundedNumbers(r, new Set<number>());
        const h = out.experience[0].highlights[0];
        expect(h).not.toMatch(/\s{2,}/);
        expect(h).not.toMatch(/\s,/);
        expect(h).not.toMatch(/^by |^of |^to |^with /i);
    });
});

describe('stripUngroundedNumbers — LLM shape drift (run 850b81d0 regression)', () => {
    // The resume-expand tool schema leaves keyAchievements items unshaped and
    // ResumeRewriteSchema passthroughs them, so the model can emit entries
    // without an `achievement` string. The deterministic guard must be TOTAL:
    // scrub what is a string, pass through what is not — never crash the run.
    it('tolerates a keyAchievements entry without an achievement string', () => {
        const r = resume({
            keyAchievements: [
                { title: 'Cost saver' } as unknown as StructuredResumeData['keyAchievements'][number],
                { achievement: 'Cut spend 90% across 4 systems' },
            ],
        });
        const out = stripUngroundedNumbers(r, new Set([4]));
        expect(out.keyAchievements[0]).toEqual({ title: 'Cost saver' });
        expect(out.keyAchievements[1].achievement).not.toContain('90');
        expect(out.keyAchievements[1].achievement).toContain('4');
    });

    it('tolerates undefined summary and non-string highlight entries', () => {
        const r = resume({
            summary: undefined as unknown as string,
            experience: [{
                company: 'Acme', title: 'Engineer', period: '2020-2024',
                highlights: ['Shipped 7 services', undefined] as unknown as string[],
            }],
        });
        const out = stripUngroundedNumbers(r, new Set<number>());
        expect(out.summary).toBeUndefined();
        expect(out.experience[0].highlights[0]).not.toContain('7');
        expect(out.experience[0].highlights[1]).toBeUndefined();
    });
});

describe('stripInstructionMetrics', () => {
    const persona = 'Impact metrics tell OUTCOMES (30-second deploys vs 8-minute manual cycles). experience: 370 words max.';

    it('strips a unit metric whose value exists only in the instructions (the 2026-07-08 leak)', () => {
        const r = resume({
            experience: [{
                company: 'A', title: 'B', period: '2021 - 2022',
                highlights: ['Reduced IAM-only change deployment from 8 minutes to 30 seconds via OIDC handoff.'],
            }],
        });
        const out = stripInstructionMetrics(r, { instructionText: persona, evidenceText: 'OIDC federation for CI.' });
        const h = out.experience[0].highlights[0];
        expect(h).not.toMatch(/8\s*minutes/);
        expect(h).not.toMatch(/30\s*seconds/);
        expect(h).toContain('OIDC handoff');
    });

    it('keeps the same metric when the evidence states those numbers', () => {
        const r = resume({
            experience: [{
                company: 'A', title: 'B', period: 'p',
                highlights: ['Reduced deployment from 8 minutes to 30 seconds.'],
            }],
        });
        const out = stripInstructionMetrics(r, {
            instructionText: persona,
            evidenceText: 'Pipeline timing doc: full deploy fell from 8 minutes to 30 seconds after change detection.',
        });
        expect(out.experience[0].highlights[0]).toContain('8 minutes to 30 seconds');
    });

    it('never touches unit-free numbers like standard names or years', () => {
        const r = resume({
            summary: 'Engineer since 2021 applying CDK-Nag NIST 800-53 rule packs.',
        });
        const out = stripInstructionMetrics(r, {
            instructionText: 'NIST 800-53 examples; 2021 word cap.',
            evidenceText: '',
        });
        expect(out.summary).toBe('Engineer since 2021 applying CDK-Nag NIST 800-53 rule packs.');
    });

    it('strips an instruction-only percentage', () => {
        const r = resume({ summary: 'Improved throughput by 370% on the ingest path.' });
        const out = stripInstructionMetrics(r, { instructionText: persona, evidenceText: '' });
        expect(out.summary).not.toContain('370');
        expect(out.summary).toContain('ingest path');
    });

    it('leaves metrics alone when their values never appear in the instructions', () => {
        const r = resume({ summary: 'Cut p95 latency by 42% in 6 weeks.' });
        const out = stripInstructionMetrics(r, { instructionText: persona, evidenceText: '' });
        expect(out.summary).toBe('Cut p95 latency by 42% in 6 weeks.');
    });
});
