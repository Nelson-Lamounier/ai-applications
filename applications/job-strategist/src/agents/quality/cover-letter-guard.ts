/** @format */

import { z } from 'zod';
import { runAgent, log, normalizeProse } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, CoverLetter } from '@bedrock/shared';

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
// Third-person self-reference — a cover letter speaks as "I". The strategist's
// internal artifacts (yearsGap.framingLine, fit summaries) are authored in
// third person ("this candidate brings…") and have leaked verbatim into
// letters. Any candidate self-reference in third person is a violation.
const THIRD_PERSON_SELF = /\b(?:this|the)\s+candidate(?:['’]s)?\b/i;
// Forward-looking skill-acquisition claim — the candidate states they are
// learning/onboarding a skill they lack (e.g. "actively beginning Azure
// onboarding"). Two-part check: an intent adverb must appear within 40 chars
// of an acquisition verb, so legitimate "new engineer onboarding" (people,
// not a skill) does NOT fire (no intent adverb present).
const FORWARD_LOOKING_INTENT = /\b(actively|currently|presently|now)\b/gi;
const FORWARD_LOOKING_ACQUIRE = /\b(beginning|starting|begin|start|pursuing|pursue|onboarding|onboard|learning|learn|studying|study|self-?teach(?:ing)?|ramping up|upskilling)\b/i;

/** Returns true when the 40-char window after an intent word contains an acquisition verb with no intervening period. */
function windowContainsAcquire(text: string, afterIndex: number): boolean {
    const window = text.slice(afterIndex, afterIndex + 40);
    const acquireMatch = FORWARD_LOOKING_ACQUIRE.exec(window);
    if (!acquireMatch) return false;
    // Reject if a sentence boundary (period) appears before the acquire verb in the window.
    const beforeAcquire = window.slice(0, acquireMatch.index);
    return !beforeAcquire.includes('.');
}

/** Returns true when an intent adverb is immediately followed (within 40 chars, same sentence) by an acquisition verb. */
function hasForwardLookingSkillClaim(text: string): boolean {
    FORWARD_LOOKING_INTENT.lastIndex = 0;
    let intentMatch: RegExpExecArray | null;
    while ((intentMatch = FORWARD_LOOKING_INTENT.exec(text)) !== null) {
        const afterIntent = intentMatch.index + intentMatch[0].length;
        if (windowContainsAcquire(text, afterIntent)) return true;
    }
    return false;
}
/**
 * Narrative-quality inputs (all optional — absent inputs skip their checks).
 * These carry the run's JD context so violations repair against the REAL JD.
 */
export interface CoverLetterNarrativeOpts {
    /** False when the JD sets no years requirement (tenure must not appear). */
    readonly hasYearsBar?: boolean;
    /** JD soft/implicit requirement phrases (the values rubric). */
    readonly valuesSignals?: readonly string[];
    /** Documented project pitches for the ownership story. */
    readonly projectPitches?: ReadonlyArray<{ name: string; pitch: string }>;
    /** The JD's company problem (P1's plain-language anchor). */
    readonly companyProblem?: string;
    /** Numbers appearing in the tailored resume (overlap = restating). */
    readonly resumeNumbers?: ReadonlySet<string>;
}

const TENURE_RE = /\b\d+\+?\s*years?\b/i;
/** Technical tokens a recruiter cannot parse: acronyms, camelCase identifiers, paths. */
const TECH_TOKEN_RE = /\b[A-Z]{2,}[A-Za-z0-9]*\b|\b[A-Za-z]+[A-Z][A-Za-z]*\b|\/[a-z][\w/.-]+/g;
/** Widely-known acronyms a recruiter DOES parse — excluded from the density count. */
const RECRUITER_SAFE = new Set(['AWS', 'CI', 'CD', 'IT', 'AI', 'API', 'DEVOPS', 'SAAS']);
const MAX_P1_TECH_TOKENS = 4;
const MAX_SHARED_RESUME_NUMBERS = 1;

function numbersInText(text: string): Set<string> {
    return new Set((text.match(/\d+(?:[.,]\d+)?\+?/g) ?? []).map((n) => n.replace(/[,+]/g, '')));
}

/** Distinct un-recruiter-safe technical tokens in a paragraph. */
function techTokens(paragraph: string): string[] {
    const seen = new Set<string>();
    for (const m of paragraph.match(TECH_TOKEN_RE) ?? []) {
        if (!RECRUITER_SAFE.has(m.toUpperCase())) seen.add(m);
    }
    return [...seen];
}

/**
 * Narrative checks — the letter answers a recruiter, not an engineer:
 * P1 must pass the recruiter test, tenure is conditional on a JD years bar,
 * and the letter must not restate the resume (number overlap is the symptom
 * — the Accenture letter shared SEVEN numbers with its resume).
 */
export function validateCoverLetterNarrative(letter: CoverLetter, opts: CoverLetterNarrativeOpts): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const p1 = letter.paragraphs[0] ?? '';
    const tokens = techTokens(p1);
    if (tokens.length > MAX_P1_TECH_TOKENS) {
        out.push({ code: 'opener_too_technical', detail: `P1 carries ${tokens.length} technical tokens (${tokens.slice(0, 6).join(', ')}…) — the opener must pass the recruiter test: plain language, the why-this-role connection, at most two widely-known acronyms.` });
    }
    if (opts.hasYearsBar === false && letter.paragraphs.some((p) => TENURE_RE.test(p))) {
        out.push({ code: 'tenure_without_bar', detail: 'The JD sets no years requirement (and may explicitly de-emphasise years) — remove every tenure mention; demonstrate impact and ownership instead.' });
    }
    if (opts.resumeNumbers && opts.resumeNumbers.size > 0) {
        const shared = [...numbersInText(letter.paragraphs.join(' '))].filter((n) => opts.resumeNumbers?.has(n));
        if (shared.length > MAX_SHARED_RESUME_NUMBERS) {
            out.push({ code: 'letter_restates_resume', detail: `Letter repeats ${shared.length} numbers from the resume (${shared.join(', ')}) — the resume proves, the letter tells the story; keep at most one.` });
        }
    }
    return out;
}

/** Any markdown the agent should NOT emit (formatting belongs to the UI/PDF). */
const MARKDOWN = /\*\*|__|##|^\s*[-*+]\s+/m;

const MAX_SENTENCE_WORDS = 40;

/** True when any body sentence exceeds MAX_SENTENCE_WORDS words. */
function hasLongSentence(paragraphs: readonly string[]): boolean {
    const body = paragraphs.join(' ');
    return body
        .split(/(?<=[.!?])\s+/)
        .some((s) => s.trim().split(/\s+/).filter(Boolean).length > MAX_SENTENCE_WORDS);
}

/** Push title violations (missing_title, wrong_title) onto out. */
function checkTitleViolations(out: CoverLetterViolation[], lower: string, targetRole: string, leadIdentity: string): void {
    if (targetRole && !lower.includes(targetRole.toLowerCase())) {
        out.push({ code: 'missing_title', detail: `Body never names the target role "${targetRole}".` });
    }
    if (!leadIdentity || leadIdentity.toLowerCase() === targetRole.toLowerCase()) return;
    const li = leadIdentity.toLowerCase();
    if (lower.includes(`${li} role`) || lower.includes(`${li} position`)) {
        out.push({ code: 'wrong_title', detail: `Body uses the positioning identity "${leadIdentity}" as the role name.` });
    }
}

/**
 * Deterministic checks on the STRUCTURED cover letter. Content rules (title,
 * self-rejection, unrealised impact) run on the joined text; `has_markdown`
 * ensures the agent emitted clean prose — formatting is the renderer's job.
 */
export function validateCoverLetter(letter: CoverLetter, targetRole: string, leadIdentity: string): CoverLetterViolation[] {
    const out: CoverLetterViolation[] = [];
    const text  = [letter.greeting, ...letter.paragraphs].join('\n');
    const lower = text.toLowerCase();

    checkTitleViolations(out, lower, targetRole, leadIdentity);
    for (const re of GAP_PATTERNS) {
        if (re.test(text)) { out.push({ code: 'names_gap', detail: `Matched self-rejection/arguing pattern: ${re}` }); break; }
    }
    if (hasForwardLookingSkillClaim(text)) out.push({ code: 'forward_looking_skill_claim', detail: 'Claims to be actively learning/onboarding a skill — omit unevidenced forward-looking acquisition; use grounded transferable framing instead.' });
    if (THIRD_PERSON_SELF.test(text)) out.push({ code: 'third_person_voice', detail: 'Letter refers to "this candidate"/"the candidate" — cover letters speak in first person; rewrite the sentence as "I…" with the same facts.' });
    if (UNREALISED.test(text)) out.push({ code: 'unrealised_impact', detail: 'Claims not-yet-realised impact.' });
    if (MARKDOWN.test(text))   out.push({ code: 'has_markdown', detail: 'Agent emitted markdown formatting — the UI/PDF owns formatting; output must be plain text.' });
    if (hasLongSentence(letter.paragraphs)) {
        out.push({ code: 'long_sentence', detail: `A sentence exceeds ${MAX_SENTENCE_WORDS} words — split comma-joined clauses into shorter sentences.` });
    }
    if (letter.greeting.trim().length > 0 && !letter.greeting.trim().endsWith(',')) {
        out.push({ code: 'greeting_format', detail: 'Greeting must end with a comma (e.g. "Dear Hiring Manager,").' });
    }

    return out;
}

/** Normalize em-dashes in all prose fields of a CoverLetter. */
export function stripEmDashes(cl: CoverLetter): CoverLetter {
    return {
        greeting:   normalizeProse(cl.greeting),
        paragraphs: cl.paragraphs.map(normalizeProse),
        signoff:    cl.signoff,   // identity — leave untouched
    };
}

// =============================================================================
// STANDALONE RULE PREDICATES (Phase 5 PR-B Task 10 -- additive)
// =============================================================================
// The five checks below back the cover-letter eval (evals/cover-letter/). Two
// of them (`checkTenureConditional`, `checkThirdPersonVoice`) isolate a rule
// this file already enforced BUNDLED inside `validateCoverLetterNarrative` /
// `validateCoverLetter` -- restated standalone here, reusing the same private
// regexes (TENURE_RE, THIRD_PERSON_SELF), so the eval can grade that one rule
// without also depending on the P1-technical-density / title / markdown /
// sentence-length checks that ship in the same bundled function. The other
// three (`checkParagraphCount`, `checkSignoffComplete`, `checkNoEmDash`) had
// no standalone predicate at all -- the "exactly 3 paragraphs" contract lived
// only in the `emit_cover_letter` tool description, the signoff was assumed
// complete because it is copied verbatim from Candidate Contact, and em-dash
// handling was mutate-only (`stripEmDashes`). None of these five are wired
// into `guardCoverLetter`'s runtime violation list -- they exist purely so the
// eval and any future runtime caller share one source of truth instead of the
// eval re-implementing the rules.

const EXPECTED_PARAGRAPH_COUNT = 3;

/** Exactly `EXPECTED_PARAGRAPH_COUNT` paragraphs -- the `emit_cover_letter` tool description's contract, made a gradeable predicate. */
export function checkParagraphCount(letter: CoverLetter): CoverLetterViolation[] {
    if (letter.paragraphs.length === EXPECTED_PARAGRAPH_COUNT) return [];
    return [{ code: 'paragraph_count', detail: `Letter has ${letter.paragraphs.length} paragraphs -- must be exactly ${EXPECTED_PARAGRAPH_COUNT}.` }];
}

const SIGNOFF_FIELDS: ReadonlyArray<keyof CoverLetter['signoff']> = ['name', 'email', 'linkedin', 'github'];

/** Every signoff field non-empty -- the block is meant to be copied verbatim from the Candidate Contact block, so a blank field is a genuine defect. */
export function checkSignoffComplete(letter: CoverLetter): CoverLetterViolation[] {
    const missing = SIGNOFF_FIELDS.filter((f) => letter.signoff[f].trim().length === 0);
    if (missing.length === 0) return [];
    return [{ code: 'signoff_incomplete', detail: `Signoff is missing: ${missing.join(', ')}.` }];
}

const EM_DASH_RE = /\u2014/;

/** No em-dash in any prose field -- the pre-normalisation detector counterpart to `stripEmDashes`, which silently repairs this downstream; the eval asserts the model itself avoided it. */
export function checkNoEmDash(letter: CoverLetter): CoverLetterViolation[] {
    const text = [letter.greeting, ...letter.paragraphs].join('\n');
    if (!EM_DASH_RE.test(text)) return [];
    return [{ code: 'has_em_dash', detail: 'Letter contains an em-dash -- prefer a comma or full stop.' }];
}

/** Isolated tenure-conditional check -- reuses TENURE_RE; passes vacuously whenever `hasYearsBar` is not explicitly `false` (the JD sets a years bar, or its presence is unknown). */
export function checkTenureConditional(letter: CoverLetter, hasYearsBar: boolean): CoverLetterViolation[] {
    if (hasYearsBar !== false) return [];
    if (!letter.paragraphs.some((p) => TENURE_RE.test(p))) return [];
    return [{ code: 'tenure_without_bar', detail: 'The JD sets no years requirement -- remove every tenure mention; demonstrate impact and ownership instead.' }];
}

/** Isolated first-person-voice check -- reuses THIRD_PERSON_SELF. */
export function checkThirdPersonVoice(letter: CoverLetter): CoverLetterViolation[] {
    const text = [letter.greeting, ...letter.paragraphs].join('\n');
    if (!THIRD_PERSON_SELF.test(text)) return [];
    return [{ code: 'third_person_voice', detail: 'Letter refers to "this candidate"/"the candidate" -- cover letters speak in first person.' }];
}

// =============================================================================
// HAIKU REWRITE + GUARD ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['COVER_LETTER_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Ledger identity for the inline prompt below — bump version on any wording change (pairs with system_prompt_hash in prompt_invocations). */
export const COVER_LETTER_REWRITE_PROMPT_META = { id: 'cover-letter-rewrite', version: '1' } as const;

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
    ctx: { targetRole: string; leadIdentity: string; yearsGapFraming: string; narrative?: CoverLetterNarrativeOpts },
): Promise<CoverLetter> {
    const system = [
        'You repair a cover letter, fixing ONLY the listed issues. Call emit_cover_letter with structured JSON.',
        'Output is PLAIN TEXT — never markdown, never ** or ## or list markers. The UI/PDF formats it.',
        'Rules:',
        `- Name the position EXACTLY as "${ctx.targetRole}" — never as "${ctx.leadIdentity}" or a team name.`,
        '- Remove every sentence that names, apologises for, or argues against a gap or missing experience. Delete them, do not replace.',
        '- The letter speaks in FIRST PERSON. Rewrite any sentence that says "this candidate" or "the candidate" as an "I…" sentence carrying the same facts. Never copy internal framing text verbatim.',
        ctx.yearsGapFraming ? `- Where tenure is mentioned, restate this true framing in first person, paraphrased in the letter's own voice (never verbatim): "${ctx.yearsGapFraming}".` : '- Do not state a single-role tenure that undersells the candidate.',
        '- For opener_too_technical: rewrite P1 in PLAIN language a non-technical recruiter understands — the genuine why-this-role connection and one simply-stated outcome; no error narratives, no code identifiers, at most two widely-known acronyms.',
        '- For tenure_without_bar: DELETE every years/tenure mention — this JD judges impact, ownership and learning, not tenure.',
        ctx.narrative?.valuesSignals?.length ? `- For letter_restates_resume: replace restated resume facts with STORY beats answering the JD's stated values BY NAME (${ctx.narrative.valuesSignals.slice(0, 5).join('; ')}) — ownership via the documented projects${ctx.narrative.projectPitches?.length ? ` (${ctx.narrative.projectPitches.map((pp) => `${pp.name}: ${pp.pitch.slice(0, 120)}`).join(' | ')})` : ''}, learning via a real growth arc, collaboration via cross-functional work. Keep at most ONE resume number.` : '- For letter_restates_resume: replace restated resume facts with story beats (why this role, ownership, learning, collaboration); keep at most one resume number.',
        '- Remove claims of not-yet-realised impact (e.g. "pending review").',
        '- Split any sentence longer than ~40 words into shorter sentences; prefer a full stop or comma over an em-dash.',
        '- Ensure the greeting ends with a comma (e.g. "Dear Hiring Manager,").',
        '- Do NOT invent any new factual claim. Preserve the real evidence + voice; only cut/repair the flagged problems. Keep the signoff unchanged.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'cover-letter-rewrite', modelId: MODEL_ID, maxTokens: 1500, thinkingBudget: 0,
        promptId: COVER_LETTER_REWRITE_PROMPT_META.id, promptVersion: COVER_LETTER_REWRITE_PROMPT_META.version,
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

/**
 * Deterministic backstop for the first-person rule: when the Haiku rewrite
 * fails (fail-open) or leaves third-person self-references behind, DELETE the
 * offending sentences rather than attempt a mechanical pronoun swap — the
 * guard's contract for unfixable content is cut, not mangle.
 */
export function stripThirdPersonSentences(letter: CoverLetter): { letter: CoverLetter; stripped: boolean } {
    let stripped = false;
    const paragraphs = letter.paragraphs
        .map((p) => {
            const kept = p.split(/(?<=[.!?])\s+/).filter((s) => {
                const hit = THIRD_PERSON_SELF.test(s);
                if (hit) stripped = true;
                return !hit;
            });
            return kept.join(' ').trim();
        })
        .filter((p) => p.length > 0);
    if (!stripped) return { letter, stripped };
    return { letter: { ...letter, paragraphs }, stripped };
}

/** Validate (content + narrative) → rewrite on violation → deterministic voice backstop → return. Never throws. */
export async function guardCoverLetter(
    letter: CoverLetter | null,
    targetRole: string,
    leadIdentity: string,
    yearsGapFraming: string,
    narrative: CoverLetterNarrativeOpts = {},
): Promise<{ letter: CoverLetter | null; violations: CoverLetterViolation[] }> {
    if (!letter) return { letter, violations: [] };
    const violations = [
        ...validateCoverLetter(letter, targetRole, leadIdentity),
        ...validateCoverLetterNarrative(letter, narrative),
    ];
    if (violations.length === 0) return { letter: stripEmDashes(letter), violations };
    const fixed = await rewriteCoverLetter(letter, violations, { targetRole, leadIdentity, yearsGapFraming, narrative });
    const { letter: voiced, stripped } = stripThirdPersonSentences(fixed);
    if (stripped) violations.push({ code: 'third_person_stripped', detail: 'Rewrite left third-person self-references — offending sentences deleted deterministically.' });
    return { letter: stripEmDashes(voiced), violations };
}
