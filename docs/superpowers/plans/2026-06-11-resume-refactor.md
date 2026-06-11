# Resume Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the resume land in the F-pattern for both readers — fix the summary's wrong-cluster opener, lead skills/bullets with matched terms, collapse dead-weight Projects, order education by relevance — enforced by a deterministic resume guard + Haiku rewrite.

**Architecture:** `resume-guard.ts` (deterministic `validateResume` + Haiku `rewriteResume` + `guardResume`, fail-open), wired into run-pipeline to replace the raw resume before persistence; plus persona/constraints rule fixes.

**Tech Stack:** TypeScript (NodeNext ESM, `.js`), Zod, Bedrock Haiku (`runAgent`), Jest (ts-jest CJS).

**Spec:** `docs/superpowers/specs/2026-06-11-resume-refactor-design.md`. Branch `feat/resume-refactor` (off the merged develop — Archetype 7 + yearsGap + positioning headline present). Build shared: `cd applications/shared && npx tsc --build`.

---

## Task 1: validateResume (deterministic)

**Files:** Create `applications/job-strategist/src/agents/resume-guard.ts` + `.test.ts`.

- [ ] **Step 1: Failing tests** — `resume-guard.test.ts`. `StructuredResumeData` is imported from `@bedrock/shared`; build a minimal fixture helper. Cases (assert by `code`):
```ts
/** @format */
import { validateResume } from './resume-guard.js';
import type { StructuredResumeData } from '@bedrock/shared';

const base = (over: Partial<StructuredResumeData> = {}): StructuredResumeData => ({
    profile: { name: 'Nelson', title: 'Technical Support Engineer · Cloud & AI Operations', email: 'e', location: 'Dublin' },
    summary: 'Support engineer who ships production AI. 5 years across support and operations.',
    experience: [{ company: 'AWS', title: 'Technical Customer Service Associate', period: '2022 - Present', highlights: ['Removed 10-20 hrs/week toil via automation'] }],
    skills: [{ category: 'Support & Troubleshooting', skills: ['root-cause analysis', 'SLA'] }, { category: 'Cloud', skills: ['AWS'] }],
    education: [{ degree: 'Higher Diploma in Computing', institution: 'DBS', period: '2022-2024' }],
    certifications: [], projects: [], keyAchievements: [],
    sectionOrder: ['summary', 'experience', 'projects', 'education', 'skills', 'certifications'],
    ...over,
} as StructuredResumeData);

const ctx = { targetRole: 'AI Support Engineer', leadIdentity: 'Support engineer who builds production AI', verifiedEducation: ['Higher Diploma in Computing'], archetypeSkillLead: 'Support & Troubleshooting' };
const codes = (r: StructuredResumeData) => validateResume(r, ctx).map((v) => v.code);

describe('validateResume', () => {
    it('clean resume → no violations', () => { expect(codes(base())).toEqual([]); });
    it('headline_is_title — title is a verbatim employment title / no positioning separator', () => {
        expect(codes(base({ profile: { name: 'N', title: 'Technical Customer Service Associate', email: 'e', location: 'D' } }))).toContain('headline_is_title');
    });
    it('summary_wrong_cluster — first sentence lacks the leadIdentity head noun', () => {
        expect(codes(base({ summary: 'Cloud infrastructure engineer with 3+ years triaging AWS escalations.' }))).toContain('summary_wrong_cluster');
    });
    it('summary_names_gap — raw years-gap / self-deprecation', () => {
        expect(codes(base({ summary: 'Support engineer whose 3 years falls short of the 8-year requirement.' }))).toContain('summary_names_gap');
    });
    it('education_mismatch — a degree not in verifiedEducation', () => {
        expect(codes(base({ education: [{ degree: 'BA in Digital Marketing', institution: 'DBS', period: '2016-2020' }] }))).toContain('education_mismatch');
    });
    it('skills_lead_mismatch — first skill group is not the archetype lead', () => {
        expect(codes(base({ skills: [{ category: 'Cloud', skills: ['AWS'] }, { category: 'Support & Troubleshooting', skills: ['SLA'] }] }))).toContain('skills_lead_mismatch');
    });
});
```
Run `cd applications/job-strategist && yarn test resume-guard` → FAIL.

- [ ] **Step 2: Implement** `resume-guard.ts` (deterministic):
```ts
/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

export interface ResumeViolation { code: string; detail: string; }
export interface ResumeGuardCtx {
    targetRole: string;
    leadIdentity: string;
    verifiedEducation: string[];
    archetypeSkillLead: string;
}

const GAP_RE = /falls?\s+short|\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)|do(?:es)?\s*not\s+yet\s+have/i;

/** Head tokens (>3 chars) of the lead identity — the summary's first sentence should echo one. */
function headTokens(leadIdentity: string): string[] {
    return leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    const title = (resume.profile?.title ?? '').trim();

    // headline_is_title — positioning headline must carry a separator and not be a verbatim employment title
    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set((resume.experience ?? []).map((e) => (e.title ?? '').toLowerCase().trim()));
    if (title && (!hasSeparator || employmentTitles.has(title.toLowerCase()))) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim, not a positioning headline.` });
    }

    // summary_wrong_cluster — first sentence must echo a leadIdentity head token
    const summary = (resume.summary ?? '').trim();
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0]?.toLowerCase() ?? '';
    const tokens = headTokens(ctx.leadIdentity);
    if (summary && tokens.length > 0 && !tokens.some((t) => firstSentence.includes(t))) {
        out.push({ code: 'summary_wrong_cluster', detail: 'Summary opener does not lead with the archetype lead-identity differentiator.' });
    }

    // summary_names_gap — the summary must not hand over the years gap
    if (GAP_RE.test(summary)) out.push({ code: 'summary_names_gap', detail: 'Summary names/concedes the experience gap.' });

    // education_mismatch — every degree must match a verified-education string (substring, case-insensitive)
    const verified = ctx.verifiedEducation.map((v) => v.toLowerCase());
    for (const ed of resume.education ?? []) {
        const deg = (ed.degree ?? '').toLowerCase();
        if (deg && !verified.some((v) => v.includes(deg) || deg.includes(v))) {
            out.push({ code: 'education_mismatch', detail: `Education "${ed.degree}" not in the verified facts.` });
            break;
        }
    }

    // skills_lead_mismatch — first skill group must be the archetype lead (when one is required)
    if (ctx.archetypeSkillLead) {
        const firstCat = (resume.skills?.[0]?.category ?? '').toLowerCase();
        if (firstCat && firstCat !== ctx.archetypeSkillLead.toLowerCase()) {
            out.push({ code: 'skills_lead_mismatch', detail: `First skill group "${resume.skills?.[0]?.category}" is not the archetype lead "${ctx.archetypeSkillLead}".` });
        }
    }

    return out;
}
```
(Verify the `StructuredResumeData` field names against `@bedrock/shared` — `profile.title`, `summary`, `experience[].title`, `skills[].category`, `education[].degree`. Adjust optional-chaining to the real shape.)

- [ ] **Step 3:** `yarn test resume-guard` → PASS; `npx tsc --noEmit` → clean. Commit:
```bash
git add applications/job-strategist/src/agents/resume-guard.ts applications/job-strategist/src/agents/resume-guard.test.ts
git commit -m "feat(strategist): deterministic resume validator (F-pattern content checks)"
```

---

## Task 2: Haiku rewrite + guard orchestrator

**Files:** Modify `resume-guard.ts` + `.test.ts`; add `'resume-rewrite'` to `AgentName` in `applications/shared/src/types.ts`.

- [ ] **Step 1: Failing tests** (append; mock `@bedrock/shared` — NOTE: the validator imports a TYPE from `@bedrock/shared`, so the mock must still provide `StructuredResumeData` as a type (types are erased — a `jest.mock` factory returning `{ runAgent, log }` is fine; the type import is compile-time only)):
```ts
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined }));
import { runAgent } from '@bedrock/shared';
import { guardResume } from './resume-guard.js';
const mockRun = runAgent as jest.Mock;

describe('guardResume', () => {
    it('clean resume → unchanged, no rewrite call', async () => {
        const r = base();
        const res = await guardResume(r, ctx);
        expect(res.resume).toBe(r); expect(res.violations).toEqual([]); expect(mockRun).not.toHaveBeenCalled();
    });
    it('violations → calls rewrite, returns fixed + original violations', async () => {
        const fixed = base();
        mockRun.mockResolvedValue({ data: fixed });
        const bad = base({ summary: 'Cloud infrastructure engineer with 3 years that falls short of the 8-year bar.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toBe(fixed);
        expect(res.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['summary_wrong_cluster', 'summary_names_gap']));
    });
    it('rewrite throws → returns ORIGINAL (fail-open)', async () => {
        mockRun.mockRejectedValue(new Error('down'));
        const bad = base({ summary: 'Cloud infrastructure engineer, 3 years, falls short.' });
        const res = await guardResume(bad, ctx);
        expect(res.resume).toBe(bad);
    });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** the Haiku rewrite + orchestrator (mirror `cover-letter-guard.ts`'s `rewriteCoverLetter`/`guardCoverLetter`). Imports: `import { z } from 'zod'; import { runAgent, log } from '@bedrock/shared'; import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';`.
```ts
const MODEL_ID = process.env['RESUME_GUARD_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
// RewriteSchema mirrors StructuredResumeData's shape (profile/summary/experience/skills/education/certifications/projects/keyAchievements/sectionOrder).
// Build it with z.object(...). Keep it permissive (passthrough) but require profile/summary/experience/skills/education.
```
`rewriteResume(resume, violations, ctx): Promise<StructuredResumeData>` — forced-tool `emit_resume`, system prompt: "Fix ONLY the listed issues by REORDERING / REWORDING for prominence. NEVER fabricate, NEVER change a number, NEVER rename a degree (use these verified names: <verifiedEducation>). Make the summary's first sentence lead with: <leadIdentity>. Put the <archetypeSkillLead> skill group first. Lead each role with its strongest number-led bullet. Return the full resume JSON." Fail-open (catch → return input). `guardResume(resume, ctx)`: validate → if violations, rewrite → return `{ resume: fixed, violations }`; else `{ resume, violations: [] }`. Never throws.
Add `'resume-rewrite'` to `AgentName`; `cd applications/shared && npx tsc --build`.

- [ ] **Step 3:** `yarn test resume-guard` → PASS; `npx tsc --noEmit` clean. Commit `feat(strategist): resume Haiku rewrite + guard orchestrator (fail-open)`.

---

## Task 3: persona / constraints rule fixes

**Files:** `applications/job-strategist/src/prompts/resume-constraints.ts` + `strategist-persona.ts` + a presence test.

- [ ] **Step 1: Fix the summary quick-map** — in `resume-constraints.ts`, find the JD-signal → summary-variant table (grep "Cloud infrastructure engineer"). Replace the support/TSE opener so it leads with the archetype `leadIdentity` differentiator + the strongest number + the AI/portfolio hook + the cert — NOT "Cloud infrastructure engineer". State: "the summary's first sentence MUST echo the selected archetype's lead identity; for a support/customer archetype, lead with the support+AI differentiator, never an infrastructure-first identity."
- [ ] **Step 2: Skills** — add a generic rule (not archetype-6-only): "(a) the FIRST skill group must be the archetype's matched-domain group (support archetype → 'Support & Troubleshooting' with escalation/root-cause/SaaS-troubleshooting/SLA terms); (b) within every group, list JD-matched/required terms first, infra jargon last."
- [ ] **Step 3: Experience lead-bullet** — add: "Within each role, after archetype-category ordering, the FIRST bullet must be the strongest number-led/impact bullet (only bullets 1-2 are read)."
- [ ] **Step 4: Projects collapse** — add: "When the selected archetype deprioritises standalone projects (support/customer archetypes), emit Projects as a SINGLE compact 'Selected work:' line of curated, deduped GitHub links under the relevant role — NOT a standalone block. Builder archetypes keep the full block."
- [ ] **Step 5: Education ordering** — add: "Order education by relevance-then-recency; do not give the older/less-relevant degree its own emphasis; degree names stay verbatim (never rename)."
- [ ] **Step 6: Presence test** `resume-constraints.test.ts` (or extend a persona test): assert the constraints text NO LONGER hardcodes a "Cloud infrastructure engineer" support opener, and contains the skills-lead / lead-bullet / projects-collapse / education-order rules (tolerant substrings). Run `yarn test`.
- [ ] **Step 7:** `npx tsc --noEmit && yarn test` → green. Commit `feat(strategist): F-pattern resume rules (summary cluster, skills lead, lead-bullet, projects collapse, education order)`.

---

## Task 4: wire guardResume into run-pipeline

**Files:** `applications/job-strategist/src/run-pipeline.ts`.

- [ ] **Step 1:** Import `guardResume`. Add a `Counter` `job_strategist_resume_violations_total{code}` (mirror `coverLetterViolations`).
- [ ] **Step 2:** Where the tailored resume is produced (grep `tailoredResumeData`), after it's available + the archetype/leadIdentity are known, derive the `archetypeSkillLead` (a small map: a support/customer archetype → 'Support & Troubleshooting', else ''), the `verifiedEducation` (the verbatim degree names already loaded via `formatEducation`/`educationEntries` — pass the degree strings), then:
```ts
        const { resume: finalResume, violations: resumeViolations } = await guardResume(tailoredResumeData, {
            targetRole: research.data.targetRole,
            leadIdentity: analysis.data.archetypeSelection?.leadIdentity ?? '',
            verifiedEducation: educationEntries.map((e) => e.degree),
            archetypeSkillLead,
        });
        for (const v of resumeViolations) resumeViolationsMetric.inc({ code: v.code });
```
- [ ] **Step 3:** Replace `tailoredResumeData` with `finalResume` in the persistence/consumption paths: `persistTailoredResume`, the ATS check (`renderCheckAndStoreAts`), the PDF render input, the prose linter, and the metadata stash. Grep every `tailoredResumeData` use after the guard point.
- [ ] **Step 4:** `cd applications/shared && npx tsc --build && cd ../job-strategist && npx tsc --noEmit && yarn test` → green. Commit `feat(strategist): guard the resume before persistence + violation metric`, then `git push -u origin feat/resume-refactor` and open a PR → develop.

---

## Deploy + verify
- PR `feat/resume-refactor` → develop → build → SSM → job-strategist.
- Re-run the JB → the resume should: open the summary with the support+AI differentiator (not "Cloud infrastructure engineer"), lead skills with "Support & Troubleshooting", front-load number-led bullets, collapse Projects to a "Selected work" line, order education HDip-first; the `resume_violations_total` metric shows what was caught.
