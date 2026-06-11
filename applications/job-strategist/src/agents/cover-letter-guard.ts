/** @format */

import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, CoverLetter, CoverLetterSignoff } from '@bedrock/shared';

export type { CoverLetter } from '@bedrock/shared';
export type { CoverLetterSignoff } from '@bedrock/shared';

export interface CoverLetterViolation { code: string; detail: string; }

const GAP_PATTERNS: ReadonlyArray<RegExp> = [
    /falls?\s+short/i,
    /(?:do not|does not|have not|don['’]t|doesn['’]t|haven['’]t)\s+yet\s+have/i,
    /lack(?:ing)?\s+(?:direct\s+|hands-on\s+)?experience/i,
    /\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)/i,
    /I would be surprised/i,
    /while I (?:do not|have not|don['’]t|haven['’]t|lack)\b/i,
];
const UNREALISED = /pending (?:security )?review|not yet (?:shipped|deployed|in production)|once (?:approved|shipped)/i;
/** Any markdown the agent should NOT emit (formatting belongs to the UI/PDF). */
const MARKDOWN = /\*\*|__|##|^\s*[-*+]\s+/m;

/**
 * Deterministic checks on the STRUCTURED cover letter. Content rules (title,
 * self-rejection, unrealised impact) run on the joined text; `has_markdown`
 * ensures the agent emitted clean prose — formatting is the renderer's job.
 */
export function validateCoverLetter(letter: CoverLetter, targetRole: string, leadIdentity: string): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const text  = [letter.greeting, ...letter.paragraphs].join('\n');
    const lower = text.toLowerCase();

    if (targetRole && !lower.includes(targetRole.toLowerCase())) {
        out.push({ code: 'missing_title', detail: `Body never names the target role "${targetRole}".` });
    }
    if (leadIdentity && leadIdentity.toLowerCase() !== targetRole.toLowerCase()) {
        const li = leadIdentity.toLowerCase();
        if (lower.includes(`${li} role`) || lower.includes(`${li} position`)) {
            out.push({ code: 'wrong_title', detail: `Body uses the positioning identity "${leadIdentity}" as the role name.` });
        }
    }
    for (const re of GAP_PATTERNS) {
        if (re.test(text)) { out.push({ code: 'names_gap', detail: `Matched self-rejection/arguing pattern: ${re}` }); break; }
    }
    if (UNREALISED.test(text)) out.push({ code: 'unrealised_impact', detail: 'Claims not-yet-realised impact.' });
    if (MARKDOWN.test(text))   out.push({ code: 'has_markdown', detail: 'Agent emitted markdown formatting — the UI/PDF owns formatting; output must be plain text.' });

    return out;
}

// =============================================================================
// HAIKU REWRITE + GUARD ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['COVER_LETTER_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const SignoffSchema = z.object({ name: z.string(), email: z.string(), linkedin: z.string(), github: z.string() });
const RewriteSchema = z.object({ greeting: z.string(), paragraphs: z.array(z.string()), signoff: SignoffSchema });

const TOOL = {
    name: 'emit_cover_letter',
    description: 'Return the corrected cover letter as structured JSON (plain text, NO markdown).',
    input_schema: {
        type: 'object',
        properties: {
            greeting:   { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            signoff:    { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, linkedin: { type: 'string' }, github: { type: 'string' } }, required: ['name', 'email', 'linkedin', 'github'], additionalProperties: false },
        },
        required: ['greeting', 'paragraphs', 'signoff'],
        additionalProperties: false,
    },
} as const;

const CTX: BasePipelineContext = { pipelineId: 'cover-letter-guard', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteCoverLetter(
    letter: CoverLetter,
    violations: CoverLetterViolation[],
    ctx: { targetRole: string; leadIdentity: string; yearsGapFraming: string },
): Promise<CoverLetter> {
    const system = [
        'You repair a cover letter, fixing ONLY the listed issues. Call emit_cover_letter with structured JSON.',
        'Output is PLAIN TEXT — never markdown, never ** or ## or list markers. The UI/PDF formats it.',
        'Rules:',
        `- Name the position EXACTLY as "${ctx.targetRole}" — never as "${ctx.leadIdentity}" or a team name.`,
        '- Remove every sentence that names, apologises for, or argues against a gap or missing experience. Delete them, do not replace.',
        ctx.yearsGapFraming ? `- Where tenure is mentioned, use this true framing instead: "${ctx.yearsGapFraming}".` : '- Do not state a single-role tenure that undersells the candidate.',
        '- Remove claims of not-yet-realised impact (e.g. "pending review").',
        '- Do NOT invent any new factual claim. Preserve the real evidence + voice; only cut/repair the flagged problems. Keep the signoff unchanged.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'cover-letter-rewrite', modelId: MODEL_ID, maxTokens: 1500, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<letter>${JSON.stringify(letter)}</letter>`;

    try {
        const result = await runAgent<CoverLetter>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = RewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`cover-letter-rewrite: ${parsed.error.message}`);
                return parsed.data;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'cover-letter rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return letter;
    }
}

/** Validate → rewrite on violation → return. Never throws. */
export async function guardCoverLetter(
    letter: CoverLetter | null,
    targetRole: string,
    leadIdentity: string,
    yearsGapFraming: string,
): Promise<{ letter: CoverLetter | null; violations: CoverLetterViolation[] }> {
    if (!letter) return { letter, violations: [] };
    const violations = validateCoverLetter(letter, targetRole, leadIdentity);
    if (violations.length === 0) return { letter, violations };
    const fixed = await rewriteCoverLetter(letter, violations, { targetRole, leadIdentity, yearsGapFraming });
    return { letter: fixed, violations };
}
