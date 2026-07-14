/**
 * @format
 * Summary integrity gate — the last line of defence for the single most
 * recruiter-visible artefact in the resume.
 *
 * Observed live (run a428bdf4): the writer produced a strong identity-first
 * summary; the refinement chain then token-stripped its numbers into broken
 * grammar ("Platform builds containerised, automated infrastructure
 * greenfield"), injected a JD-echo sentence ("...demands a builder who..."),
 * and leaked internal guard vocabulary ("Paid experience"). No pass
 * validated its own edit.
 *
 * This gate runs AFTER all passes: a deterministic lint, then a repair
 * ladder that can only ever produce grammatical output —
 *   1. one bounded LLM rewrite (rejected if it fails lint or introduces
 *      numbers outside the allowed set),
 *   2. the writer's ORIGINAL summary (if clean and number-safe),
 *   3. deterministic sentence-level pruning of the offending sentences
 *      (sentence removal is grammatical; token surgery is not).
 */
import type { AgentConfig } from '@bedrock/shared';
import { runAgent, log } from '@bedrock/shared';
import { extractNumbers } from '../ats/grounding/number-provenance.js';
import { CLAIM_STRENGTH_RULE } from './claim-strength.js';

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Ledger identity for the inline prompt below — bump version on any wording change (pairs with system_prompt_hash in prompt_invocations). */
export const SUMMARY_REPAIR_PROMPT_META = { id: 'summary-repair', version: '1' } as const;
const CTX = { pipelineId: 'resume-summary-repair', environment: process.env['ENVIRONMENT'] ?? 'development', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

export interface SummaryLintIssue { readonly code: string; readonly detail: string }

/** JD-echo and internal-vocabulary tells that must never ship in a summary. */
const BANNED = /\b(demands a|the role requires|we are looking|you will be|paid experience|the ideal candidate)\b/i;

/** Role nouns an identity-first opening contains within its first clause. */
const IDENTITY = /^[^.!?]{0,80}\b(engineer|developer|architect|lead|specialist|consultant|manager|analyst|administrator|scientist)\b/i;

function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

export function lintSummary(summary: string): SummaryLintIssue[] {
	const issues: SummaryLintIssue[] = [];
	for (const s of sentences(summary)) {
		const m = BANNED.exec(s);
		if (m) issues.push({ code: 'summary_banned_phrase', detail: `"${m[0]}" in: ${s.slice(0, 80)}` });
	}
	if (!IDENTITY.test(summary)) {
		issues.push({ code: 'summary_no_identity', detail: `opening lacks a role identity: ${summary.slice(0, 60)}` });
	}
	return issues;
}

/** Numbers in `text` are all present in `allowed` (subset check). */
function numbersWithin(text: string, allowed: ReadonlySet<number>): boolean {
	for (const n of extractNumbers(text)) if (!allowed.has(n)) return false;
	return true;
}

const REPAIR_TOOL = {
	name: 'emit_summary',
	description: 'Emit the repaired resume summary.',
	inputSchema: {
		type: 'object',
		properties: { summary: { type: 'string', minLength: 40, maxLength: 900 } },
		required: ['summary'],
		additionalProperties: false,
	} as Record<string, unknown>,
};

/** One bounded Haiku rewrite of the summary. Throws on any failure. */
async function llmRepair(current: string, original: string | null, allowed: ReadonlySet<number>): Promise<string> {
	const system = [
		'You repair a damaged professional resume summary. Call emit_summary with the fixed summary only.',
		'Requirements:',
		'- 3-4 grammatical sentences in the candidate voice; the FIRST sentence opens with a professional identity ("<Role> with ...").',
		'- Describe what the CANDIDATE did and is — never what a role demands or requires.',
		'- Never use internal phrases like "paid experience"; say "professional experience" or name the employers.',
		`- Only these numbers may appear: ${[...allowed].slice(0, 40).join(', ') || '(none)'} — do not introduce any other number.`,
		`- ${CLAIM_STRENGTH_RULE}`,
	].join('\n');
	const config: AgentConfig = {
		agentName: 'summary-repair', modelId: MODEL_ID, maxTokens: 1200, thinkingBudget: 0,
		promptId: SUMMARY_REPAIR_PROMPT_META.id, promptVersion: SUMMARY_REPAIR_PROMPT_META.version,
		systemPrompt: [{ text: system }], pipeline: 'job-strategist',
		tool: REPAIR_TOOL,
	};
	const userMessage = [
		`<damaged_summary>${current}</damaged_summary>`,
		original ? `<writer_original_summary>${original}</writer_original_summary>` : '',
		'Repair the damaged summary. Prefer the writer original phrasing where it survives the number constraint.',
	].filter(Boolean).join('\n');
	const result = await runAgent<string>({
		config, userMessage, pipelineContext: CTX,
		parseResponse: (raw) => {
			const parsed = JSON.parse(raw) as { summary?: unknown };
			if (typeof parsed.summary !== 'string' || parsed.summary.trim().length < 40) throw new Error('summary-repair: no usable summary');
			return parsed.summary.trim();
		},
	});
	return result.data;
}

export interface SummaryIntegrityResult {
	readonly summary: string;
	readonly issues: SummaryLintIssue[];
	readonly action: 'clean' | 'repaired' | 'original_restored' | 'sentence_pruned';
}

export interface SummaryIntegrityOpts {
	readonly originalSummary: string | null;
	readonly allowed: ReadonlySet<number>;
	/** Injectable for tests; defaults to the Haiku repair call. */
	readonly repair?: (current: string, original: string | null, allowed: ReadonlySet<number>) => Promise<string>;
}

/** Deterministic fallbacks when the LLM repair is unusable: the writer's
 *  clean original, else sentence-level pruning (always grammatical). */
function fallbackSummary(current: string, opts: SummaryIntegrityOpts): { summary: string; action: SummaryIntegrityResult['action'] } {
	const original = opts.originalSummary;
	if (original && lintSummary(original).length === 0 && numbersWithin(original, opts.allowed)) {
		return { summary: original, action: 'original_restored' };
	}
	const pruned = sentences(current).filter((s) => !BANNED.test(s)).join(' ');
	return { summary: pruned.length >= 40 ? pruned : current, action: 'sentence_pruned' };
}

export async function ensureSummaryIntegrity(current: string, opts: SummaryIntegrityOpts): Promise<SummaryIntegrityResult> {
	const issues = lintSummary(current);
	if (issues.length === 0) return { summary: current, issues, action: 'clean' };

	const repair = opts.repair ?? llmRepair;
	try {
		const repaired = await repair(current, opts.originalSummary, opts.allowed);
		if (lintSummary(repaired).length === 0 && numbersWithin(repaired, opts.allowed)) {
			return { summary: repaired, issues, action: 'repaired' };
		}
	} catch (e) {
		log('WARN', 'summary repair failed — falling back', { agent: 'summary-repair', error: e instanceof Error ? e.message : String(e) });
	}
	return { ...fallbackSummary(current, opts), issues };
}
