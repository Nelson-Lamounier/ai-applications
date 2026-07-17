/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt, buildUserMessage } from './case-study-agent.js';
import type { CaseStudyContext, PriorCaseStudy } from './case-study-types.js';

const baseCtx: CaseStudyContext = {
    projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
    components: [], repositories: [], commits: [], pulls: [], kbChunks: [],
};

describe('buildSystemPrompt', () => {
    it('returns the base prompt unchanged when no archetype', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).not.toMatch(/Project calibration/);
    });

    it('appends a calibration block when an archetype is present', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'production_saas', name: 'Production SaaS Application' },
            stage: 'senior',
            prioritySections: ['architecture', 'deployment'],
        });
        expect(prompt).toMatch(/Project calibration/);
        expect(prompt).toMatch(/senior-level Production SaaS Application/);
        expect(prompt).toMatch(/architecture, deployment/);
        expect(prompt).toMatch(/never truthfulness/);
    });

    it('includes a de-emphasis line when deemphasizedSections is set', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'production_saas', name: 'Production SaaS Application' },
            stage: 'junior',
            prioritySections: ['hero'],
            deemphasizedSections: ['design_decisions'],
        });
        expect(prompt).toMatch(/De-emphasise: design_decisions\./);
    });

    it('handles archetype with null stage (uses "unspecified")', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            archetype: { id: 'cli_tool', name: 'Published CLI Tool' },
            stage: null,
            prioritySections: ['installation'],
        });
        expect(prompt).toMatch(/unspecified-level Published CLI Tool/);
    });
});

const prior: PriorCaseStudy = {
    tagline: 'old tagline', pitch: 'old pitch',
    decisions: [], highlights: [], challenges: [], stack: [],
};

describe('buildSystemPrompt — refine mode', () => {
    it('omits the REFINE block for a from-scratch run', () => {
        expect(buildSystemPrompt(baseCtx)).not.toMatch(/REFINE MODE/);
    });

    it('appends the REFINE block when a prior case study is present', () => {
        const out = buildSystemPrompt({ ...baseCtx, priorCaseStudy: prior });
        expect(out).toMatch(/REFINE MODE/);
        expect(out).toMatch(/PRESERVE prior/);
        expect(out).toMatch(/Reuse their `sourceSignals` verbatim/);
        // New-repo coverage guarantee.
        expect(out).toMatch(/COVERAGE/);
        expect(out).toMatch(/<newRepos>/);
        expect(out).toMatch(/at least one highlight AND one\s+challenge/);
    });

    it('composes refine with archetype calibration', () => {
        const out = buildSystemPrompt({
            ...baseCtx, priorCaseStudy: prior,
            archetype: { id: 'production_saas', name: 'Production SaaS' }, stage: 'senior',
        });
        expect(out).toMatch(/Project calibration/);
        expect(out).toMatch(/REFINE MODE/);
    });
});

describe('buildUserMessage — refine mode', () => {
    it('omits the priorCaseStudy block for a from-scratch run', () => {
        expect(buildUserMessage(baseCtx)).not.toMatch(/<priorCaseStudy>/);
    });

    it('includes the priorCaseStudy block when present', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior });
        expect(out).toMatch(/<priorCaseStudy>/);
        expect(out).toMatch(/old tagline/);
    });

    it('includes <newRepos> when under-represented repos are flagged', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior, refineNewRepos: ['acme/web'] });
        expect(out).toMatch(/<newRepos>/);
        expect(out).toMatch(/acme\/web/);
    });

    it('omits <newRepos> when the list is empty', () => {
        const out = buildUserMessage({ ...baseCtx, priorCaseStudy: prior, refineNewRepos: [] });
        expect(out).not.toMatch(/<newRepos>/);
    });
});

describe('emit_case_study tool schema — output trim', () => {
    it('does not ask the model for depthMarkers (deterministically derived, then overridden)', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        expect(CASE_STUDY_TOOL.inputSchema.properties).not.toHaveProperty('depthMarkers');
        expect(CASE_STUDY_TOOL.inputSchema.required).not.toContain('depthMarkers');
        // The prompt rule describing depthMarkers must be gone too.
        expect(buildSystemPrompt(baseCtx)).not.toMatch(/depthMarkers/);
    });

    it('caps resumeBullets at 3 angle sets of ≤250-char bullets (matches prompt rule 7)', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        const rb = CASE_STUDY_TOOL.inputSchema.properties.resumeBullets as {
            maxItems: number;
            items: { properties: { bullets: { items: { maxLength: number } } } };
        };
        expect(rb.maxItems).toBe(3);
        expect(rb.items.properties.bullets.items.maxLength).toBe(250);
    });
});

describe('system prompt — highlight coverage + metric translation rules', () => {
    it('requires one plain-language headline-capability highlight, phrased for any archetype', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/At least ONE highlight/);
        // Archetype-neutral: the rule must speak to apps, infrastructure/IaC,
        // and libraries/CLIs — not just visitor-facing web products.
        expect(prompt).toMatch(/provisions, automates or operates/);
        expect(prompt).toMatch(/lets a developer/);
    });

    it('requires metrics to be translated to plain English before the number', () => {
        const prompt = buildSystemPrompt(baseCtx);
        // \s+ — the prompt template hard-wraps prose across indented lines.
        expect(prompt).toMatch(/plain-English\s+meaning before the number/);
    });
});

describe('system prompt — evidence-mix balance block', () => {
    it('states the app/infra mix and the balance instruction when the data holds both lanes', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            evidenceMix: { appPct: 70, infraPct: 30, appFiles: 700, infraFiles: 300 },
        });
        expect(prompt).toMatch(/Evidence mix/);
        expect(prompt).toMatch(/application code ~70%/);
        expect(prompt).toMatch(/infrastructure\/IaC ~30%/);
        expect(prompt).toMatch(/one lane must not take every slot/i);
    });

    it('omits the block entirely when the project is single-lane', () => {
        expect(buildSystemPrompt(baseCtx)).not.toMatch(/Evidence mix/);
        expect(buildSystemPrompt({ ...baseCtx, evidenceMix: null })).not.toMatch(/Evidence mix/);
    });
});

describe('system prompt — question-led highlight selection', () => {
    it("frames highlight selection as answering a hiring panel's questions, evidence-gated", () => {
        const prompt = buildSystemPrompt(baseCtx);
        // \s+ — the prompt template hard-wraps prose across indented lines.
        expect(prompt).toMatch(/questions a\s+hiring panel/i);
        expect(prompt).toMatch(/what does it do/i);
        expect(prompt).toMatch(/secured/i);
        expect(prompt).toMatch(/box-ticking claim/i);
        // Table-stakes facts must be routed to stack/architecture, not highlights.
        expect(prompt).toMatch(/belong in `stack` and\s+`architecture`/);
    });
});

describe('system prompt — challenge quality rules', () => {
    it('selects defining difficulties across the whole history, capping debugging anecdotes', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/DEFINING\s+difficulties/);
        expect(prompt).toMatch(/WHOLE\s+history/);
        expect(prompt).toMatch(/At most 2/);
        expect(prompt).toMatch(/single-incident\s+debugging/);
    });

    it('requires stakes-first problems and narrated, never transcribed, solutions', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/FIRST\s+sentence/);
        expect(prompt).toMatch(/ONE\s+identifying\s+code\s+detail/);
        expect(prompt).toMatch(/NEVER\s+transcribe\s+configuration/i);
    });

    it('explains difficultySignals as the measured map of the real battles', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/difficultySignals/);
        expect(prompt).toMatch(/approximate/);
    });
});

describe('buildUserMessage — difficultySignals block', () => {
    const signals = {
        firstCommitMonth: '2025-11',
        lastCommitMonth:  '2026-07',
        totalCommits:     405,
        areas: [{ area: 'src/auth', fixCommits: 15, totalCommits: 40, firstMonth: '2026-01', lastMonth: '2026-06' }],
    };

    it('serialises the signals when present', () => {
        const msg = buildUserMessage({ ...baseCtx, difficultySignals: signals });
        expect(msg).toContain('<difficultySignals>');
        expect(msg).toContain('src/auth');
        expect(msg).toContain('2025-11');
    });

    it('omits the block when absent or null', () => {
        expect(buildUserMessage(baseCtx)).not.toContain('<difficultySignals>');
        expect(buildUserMessage({ ...baseCtx, difficultySignals: null })).not.toContain('<difficultySignals>');
    });
});

describe('system prompt — decision log quality rules', () => {
    it('requires impact-first consequences with the tradeoff second', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/lead with what the decision\s+ACHIEVED/);
        expect(prompt).toMatch(/only then state the honest\s+tradeoff/);
    });

    it('requires the rejected alternative (evidence-gated, never invented)', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/alternative option\(s\)\s+considered/);
        expect(prompt).toMatch(/NEVER invent\s+an option/);
        expect(prompt).toMatch(/state the constraint/);
    });

    it('calibrates confidence to production evidence', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/'high' ONLY when the consequence is\s+validated by production evidence/);
    });

    it('extends whole-history selection and the differentiator slot to decisions', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/proof of\s+JUDGEMENT across the project's WHOLE history/);
        expect(prompt).toMatch(/at least one decision about\s+the product's differentiating capability/);
    });

    it('demands distinctness across decisions, challenges and highlights', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/Distinctness across sections/);
        expect(prompt).toMatch(/at most one section/);
        expect(prompt).toMatch(/Never repeat sentences/);
    });

    it('extends the evidence-mix balance to decisions', () => {
        const prompt = buildSystemPrompt({
            ...baseCtx,
            evidenceMix: { appPct: 70, infraPct: 30, appFiles: 700, infraFiles: 300 },
        });
        expect(prompt).toMatch(/balance the\s+highlights and decisions/);
    });
});

describe('emit_case_study — displayName (product name, never the repo slug)', () => {
    it('requires a displayName in the tool schema', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        expect(CASE_STUDY_TOOL.inputSchema.properties).toHaveProperty('displayName');
        expect(CASE_STUDY_TOOL.inputSchema.required).toContain('displayName');
    });

    it('instructs the model to name the product, never a repository slug', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/displayName/);
        expect(prompt).toMatch(/NEVER a\s+repository name or slug/);
        expect(prompt).toMatch(/kebab-case/);
    });
});

describe('emit_case_study — productStatement (README-derived, write-once)', () => {
    it('asks the model for a nullable product statement', async () => {
        const { CASE_STUDY_TOOL } = await import('./case-study-agent.js');
        expect(CASE_STUDY_TOOL.inputSchema.properties).toHaveProperty('productStatement');
        expect(CASE_STUDY_TOOL.inputSchema.required).toContain('productStatement');
    });

    it('gates the statement on supplied context and bans invention', () => {
        const prompt = buildSystemPrompt(baseCtx);
        expect(prompt).toMatch(/productStatement/);
        expect(prompt).toMatch(/derived\s+ONLY from/);
        expect(prompt).toMatch(/Emit null when/);
        expect(prompt).toMatch(/NEVER invent one from code alone/);
    });
});
