/**
 * @format
 * Inline-prompt ledger identities — every LLM call site must carry a
 * promptId/promptVersion into prompt_invocations.
 *
 * The md-based personas (strategist/research/jd-extractor/free) get their
 * identity from frontmatter; these twelve prompts live as TS string arrays
 * (deliberately — they interpolate run context or couple to deterministic
 * checks), so their identity is an exported PROMPT_META the editor bumps.
 * Without it the ledger falls back to the deploy-wide PROMPT_VERSION env
 * var — misleading for exactly the version-keyed comparisons that solved
 * the 2026-07-09 writer-duration bisect. system_prompt_hash (already
 * recorded per invocation) pairs with the version to expose unbumped edits.
 */
import { describe, it, expect } from '@jest/globals';
import { SURFACE_KEYWORDS_PROMPT_META } from '../quality/surface-keywords.js';
import { SURFACE_METRICS_PROMPT_META } from '../quality/surface-metrics.js';
import { ROLE_CLASSIFIER_PROMPT_META } from '../jd/role-classifier.js';
import { YEARS_RELEVANCE_PROMPT_META } from '../writer/years-gap.js';
import { COVER_LETTER_REWRITE_PROMPT_META } from '../quality/cover-letter-guard.js';
import { RESUME_REWRITE_PROMPT_META } from '../quality/resume-guard.js';
import { COACH_PROMPT_META } from '../coach/coach-agent.js';
import { RESUME_CONDENSE_PROMPT_META, RESUME_EXPAND_PROMPT_META } from '../../ats/length/length-budget.js';
import { MIGRATION_REFRAME_PROMPT_META } from '../../ats/reconcile/migration-reframe.js';
import { CORRECTIVE_RETRIEVAL_PROMPT_META } from '../../lib/corrective-retrieval.js';
import { SUMMARY_REPAIR_PROMPT_META } from '../../lib/resume/summary-integrity.js';

const METAS = [
    SURFACE_KEYWORDS_PROMPT_META,
    SURFACE_METRICS_PROMPT_META,
    ROLE_CLASSIFIER_PROMPT_META,
    YEARS_RELEVANCE_PROMPT_META,
    COVER_LETTER_REWRITE_PROMPT_META,
    RESUME_REWRITE_PROMPT_META,
    COACH_PROMPT_META,
    RESUME_CONDENSE_PROMPT_META,
    RESUME_EXPAND_PROMPT_META,
    MIGRATION_REFRAME_PROMPT_META,
    CORRECTIVE_RETRIEVAL_PROMPT_META,
    SUMMARY_REPAIR_PROMPT_META,
];

describe('inline prompt metas', () => {
    it('covers all twelve inline prompts with unique ids', () => {
        const ids = METAS.map((m) => m.id);
        expect(new Set(ids).size).toBe(12);
    });

    it('every id matches its agent name (ledger rows join agent = prompt_id 1:1)', () => {
        expect(METAS.map((m) => m.id).sort()).toEqual([
            'corrective-retrieval', 'cover-letter-rewrite', 'migration-reframe',
            'resume-condense', 'resume-expand', 'resume-rewrite', 'role-classifier',
            'strategist-coach', 'summary-repair', 'surface-keywords',
            'surface-metrics', 'years-relevance',
        ]);
    });

    it('every version is a positive integer string (bumpable, ledger-sortable)', () => {
        for (const m of METAS) {
            expect(m.version).toMatch(/^[1-9]\d*$/);
        }
    });
});
