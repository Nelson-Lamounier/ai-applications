/**
 * @format
 * Number-provenance guard — a STRICT, deterministic safety net over any
 * AI-rewritten resume text.
 *
 * The XYZ refinement pass (surface-keywords) is instructed to NEVER invent a
 * metric, but instructions are probabilistic. This guard is the deterministic
 * backstop: it strips any number from the resume's experience highlights,
 * summary, and key achievements that is NOT present in the allowed set (the
 * set of numbers that appear in the ORIGINAL resume + the grounding facts).
 *
 * GUARANTEE: after `stripUngroundedNumbers`, no number outside `allowed`
 * survives in any scrubbed field. Pure + deterministic — no I/O, no model.
 */

import type { StructuredResumeData } from '@bedrock/shared';

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g;

/**
 * All numeric values appearing in the text (integers + decimals).
 * "10-20" → {10, 20}, "90%" → {90}, "3+" → {3}, "2.5" → {2.5}.
 */
export function extractNumbers(text: string): Set<number> {
    const out = new Set<number>();
    const matches = text.match(NUMBER_TOKEN);
    if (!matches) return out;
    for (const m of matches) {
        const n = Number(m);
        if (!Number.isNaN(n)) out.add(n);
    }
    return out;
}

/**
 * A tight metric phrase around a number token: an optional leading qualifier
 * (~, ≈, approximately, about, over, up to, by, of, to) + the number + an
 * optional trailing unit/qualifier. We replace the WHOLE match for an
 * ungrounded number with a single space, then tidy.
 */
const METRIC_PHRASE =
    /\s*(?:~|≈|approximately|about|over|up\s*to|by|of|to)?\s*\d+(?:\.\d+)?\s*(?:%|\+|x|×|hrs?|hours?|k|m|years?|months?|weeks?|days?|cases?|systems?|apps?|stacks?|services?|microservices?|assertions?|tools?|people|members?)?/i;

/** Collapse whitespace, fix orphaned punctuation, drop dangling clause-leading connectors, trim. */
function tidy(text: string): string {
    let s = text;
    s = s.replace(/\s{2,}/g, ' ');
    s = s.replace(/\s+,/g, ',');
    s = s.replace(/\s+\./g, '.');
    s = s.replace(/,\s*,/g, ',');
    // Drop a dangling connector left at the very start of a clause (start of
    // string, or right after a comma / sentence boundary).
    s = s.replace(/(^|[,.]\s*)(?:by|of|to|with)\s+/gi, '$1');
    s = s.replace(/\s{2,}/g, ' ');
    s = s.replace(/\s+,/g, ',');
    s = s.replace(/\s+\./g, '.');
    s = s.replace(/^[\s,]+/, '');
    return s.trim();
}

/** Is `value` present in the input range output of `match()`? */
function isGrounded(token: string, allowed: Set<number>): boolean {
    const n = Number(token);
    return !Number.isNaN(n) && allowed.has(n);
}

/**
 * Strip every ungrounded number from a single text field.
 * Loops until no orphan number remains; deterministic, terminates because each
 * pass removes at least one ungrounded token (or falls back to removing the
 * bare token).
 */
function scrubText(text: string, allowed: Set<number>): string {
    let s = text;
    // Safety bound: at most one removal per number token in the original.
    const maxPasses = (s.match(NUMBER_TOKEN)?.length ?? 0) + 1;
    for (let pass = 0; pass <= maxPasses; pass++) {
        const firstUngrounded = findFirstUngrounded(s, allowed);
        if (firstUngrounded === null) break;
        s = removeOneOrphan(s, firstUngrounded, allowed);
    }
    // Final guarantee sweep: if any ungrounded token still survives, remove the
    // bare token outright.
    let guard = findFirstUngrounded(s, allowed);
    let guardPasses = 0;
    while (guard !== null && guardPasses <= maxPasses + 1) {
        s = tidy(s.slice(0, guard.index) + ' ' + s.slice(guard.index + guard.token.length));
        guard = findFirstUngrounded(s, allowed);
        guardPasses++;
    }
    return s;
}

/** Index + token of the first ungrounded number in `s`, or null. */
function findFirstUngrounded(s: string, allowed: Set<number>): { index: number; token: string } | null {
    NUMBER_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NUMBER_TOKEN.exec(s)) !== null) {
        if (!isGrounded(m[0], allowed)) {
            NUMBER_TOKEN.lastIndex = 0;
            return { index: m.index, token: m[0] };
        }
    }
    NUMBER_TOKEN.lastIndex = 0;
    return null;
}

/**
 * Remove the metric phrase around the ungrounded token at `target.index`.
 * Falls back to removing just the bare number token if phrase-removal would
 * reduce the field below ~15 chars (avoids mangling short bullets).
 */
function removeOneOrphan(s: string, target: { index: number; token: string }, allowed: Set<number>): string {
    // Anchor the metric-phrase match at the ungrounded token. We search a window
    // starting a little before the token to capture a leading qualifier.
    const windowStart = Math.max(0, s.lastIndexOf(' ', target.index) - 12);
    const before = s.slice(0, windowStart);
    const region = s.slice(windowStart);

    // Find the metric phrase that actually covers our target token.
    const match = matchPhraseCovering(region, target.index - windowStart);

    if (match && before.length + (region.length - match[0].length) >= 15) {
        const replaced = before + region.slice(0, match.index) + ' ' + region.slice(match.index + match[0].length);
        const tidied = tidy(replaced);
        // Ensure we actually removed THIS ungrounded token; otherwise fall back.
        if (!stillHasToken(tidied, target, allowed)) return tidied;
    }

    // Fallback: remove just the bare number token.
    return tidy(s.slice(0, target.index) + ' ' + s.slice(target.index + target.token.length));
}

/** Does an ungrounded token at roughly the same value still exist? */
function stillHasToken(s: string, target: { token: string }, allowed: Set<number>): boolean {
    const n = Number(target.token);
    const found = extractNumbers(s);
    return found.has(n) && !allowed.has(n);
}

/**
 * Find the METRIC_PHRASE match within `region` whose number span covers
 * `targetRel` (the relative index of the target token). Scans all matches.
 */
function matchPhraseCovering(region: string, targetRel: number): RegExpExecArray | null {
    const g = new RegExp(METRIC_PHRASE.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(region)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (m[0].length === 0) { g.lastIndex++; continue; }
        if (targetRel >= start && targetRel < end) return m;
    }
    return null;
}

/**
 * Strip any number in the resume's experience highlights, summary, and key
 * achievements that is NOT in `allowed`. Removes the orphan number plus its
 * adjacent unit/qualifier and tidies punctuation/whitespace.
 *
 * GUARANTEE: no number outside `allowed` survives in any scrubbed field.
 * Pure + deterministic.
 */
/**
 * Runtime view of an LLM-rewritten resume. The declared StructuredResumeData
 * type promises these fields are strings, but rewritten resumes arrive through
 * tool schemas that under-specify item shapes, so at runtime any text field
 * can be absent (run 850b81d0 crashed on a keyAchievements entry without an
 * `achievement` string). The guard reads through this honest view.
 */
interface DriftedResumeView {
    readonly summary?: unknown;
    readonly experience?: ReadonlyArray<{ readonly highlights?: ReadonlyArray<unknown> }>;
    readonly keyAchievements?: ReadonlyArray<{ readonly achievement?: unknown }>;
}

export function stripUngroundedNumbers(resume: StructuredResumeData, allowed: Set<number>): StructuredResumeData {
    // TOTAL over LLM shape drift: scrub what is a string, pass through what
    // is not — a guard must never fail the pipeline it protects.
    const view = resume as unknown as DriftedResumeView;
    const scrub = (v: unknown): unknown => (typeof v === 'string' ? scrubText(v, allowed) : v);
    return {
        ...resume,
        summary: scrub(view.summary) as string,
        experience: (view.experience ?? []).map((exp) => ({
            ...exp,
            highlights: (exp.highlights ?? []).map(scrub),
        })) as StructuredResumeData['experience'],
        keyAchievements: (view.keyAchievements ?? []).map((a) => ({
            ...a,
            achievement: scrub(a.achievement),
        })) as StructuredResumeData['keyAchievements'],
    };
}

// =============================================================================
// INSTRUCTION-NUMBER SCRUB — prompt text is never evidence
// =============================================================================

/** Unit vocabulary for an impact-metric span. Deliberately excludes bare
 *  integers, years and standard names (NIST 800-53): only number+unit shapes
 *  are instruction-leak candidates. */
const METRIC_UNITS = '(?:%|x\\b|×|ms\\b|seconds?\\b|secs?\\b|minutes?\\b|mins?\\b|hours?\\b|hrs?\\b|days?\\b|weeks?\\b)';

/** A metric span incl. an optional comparative pair ("from 8 minutes to 30
 *  seconds") and an optional leading qualifier, removed as one unit so no
 *  dangling "from … to" survives. */
const METRIC_SPAN = new RegExp(
    `(?:(?:from|by|to|in|under|within|at|of)\\s+)?(\\d+(?:\\.\\d+)?)[\\s-]*${METRIC_UNITS}` +
    `(?:\\s+to\\s+(\\d+(?:\\.\\d+)?)[\\s-]*${METRIC_UNITS})?`,
    'gi',
);

/** Remove every metric span whose numeric value(s) include a disallowed number. */
function removeDisallowedSpans(text: string, disallowed: ReadonlySet<number>): string {
    const out = text.replace(METRIC_SPAN, (span, a: string, b: string | undefined) => {
        const values = [Number(a), ...(b === undefined ? [] : [Number(b)])];
        return values.some((v) => disallowed.has(v)) ? ' ' : span;
    });
    return out === text ? text : tidy(out);
}

/**
 * Strip unit-bearing metrics whose values appear in the INSTRUCTION text (the
 * writer persona) but in none of the evidence text. The 2026-07-08 run lifted
 * "8 minutes to 30 seconds" from the persona's own impact-metric example into
 * a resume bullet — a class the original provenance guard structurally cannot
 * catch, because its allowed set is seeded with the writer's own output.
 * Pure + deterministic; unit-free numbers (years, NIST 800-53) are never touched.
 */
export function stripInstructionMetrics(
    resume: StructuredResumeData,
    opts: { readonly instructionText: string; readonly evidenceText: string },
): StructuredResumeData {
    const evidence = extractNumbers(opts.evidenceText);
    const disallowed = new Set([...extractNumbers(opts.instructionText)].filter((n) => !evidence.has(n)));
    if (disallowed.size === 0) return resume;
    const view = resume as unknown as DriftedResumeView;
    const scrub = (v: unknown): unknown => (typeof v === 'string' ? removeDisallowedSpans(v, disallowed) : v);
    return {
        ...resume,
        summary: scrub(view.summary) as string,
        experience: (view.experience ?? []).map((exp) => ({
            ...exp,
            highlights: (exp.highlights ?? []).map(scrub),
        })) as StructuredResumeData['experience'],
        keyAchievements: (view.keyAchievements ?? []).map((a) => ({
            ...a,
            achievement: scrub(a.achievement),
        })) as StructuredResumeData['keyAchievements'],
    };
}
