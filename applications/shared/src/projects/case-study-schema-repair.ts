/**
 * @format
 * Case-study schema repair — zero-cost, deterministic salvage of recoverable
 * structured-output violations.
 *
 * A forced-tool `inputSchema` (maxLength on tagline, pitch, etc.) is a HINT the
 * model usually but not always honours — Sonnet overran the 200-char tagline
 * cap and the Zod re-validation hard-rejected the ENTIRE case study, discarding
 * a 270s generation that had already incurred Bedrock cost. The vast majority of
 * such failures are length overruns (`too_big` on a string or array), which are
 * 100% repairable WITHOUT another model call: clamp the offending value to its
 * maximum and re-validate.
 *
 * This is a SINGLE bounded pass — it never calls the model, never loops, and
 * never fabricates: it only truncates over-long strings and slices over-long
 * arrays. Violations it cannot fix deterministically (e.g. `too_small` /
 * missing required fields) are left untouched, so the caller's re-validation
 * still fails fast rather than persisting a half-formed case study.
 */

import type { ZodIssue } from 'zod';

/**
 * Truncate the value at `path` to `max` length when it is an over-long string
 * or array. Navigates the clone in place; no-ops if the path doesn't resolve to
 * a clampable value (defensive — the issue list and the object can drift).
 */
type Container = Record<string | number, unknown>;

/** Walk all but the last path segment; return the parent container or undefined. */
function resolveParent(root: unknown, path: readonly (string | number)[]): Container | undefined {
    let node: unknown = root;
    for (let i = 0; i < path.length - 1; i++) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Container)[path[i]];
    }
    return node !== null && typeof node === 'object' ? (node as Container) : undefined;
}

function clampAtPath(root: unknown, path: readonly (string | number)[], max: number): void {
    const key = path.at(-1);
    if (key === undefined) return;
    const container = resolveParent(root, path);
    if (!container) return;

    const value = container[key];
    if ((typeof value === 'string' || Array.isArray(value)) && value.length > max) {
        container[key] = value.slice(0, max);
    }
}

/**
 * Given a raw model payload and the Zod issues from a failed parse, return a
 * CLONE with every recoverable `too_big` (string/array length overrun) clamped
 * to its maximum. The original is never mutated. Re-run the schema's parse on
 * the result: if it now succeeds the run is salvaged at zero model cost; if it
 * still fails the remaining violations were not length overruns and the caller
 * should fail fast.
 *
 * @param raw    The parsed-but-invalid model output (any JSON value).
 * @param issues `zodError.issues` from the failed `safeParse`.
 * @returns A repaired clone (or `raw` unchanged when it isn't an object).
 */
export function clampOversizedFields(raw: unknown, issues: readonly ZodIssue[]): unknown {
    if (raw === null || typeof raw !== 'object') return raw;

    const clone = structuredClone(raw);
    const clampedPaths: string[] = [];

    for (const issue of issues) {
        if (issue.code !== 'too_big') continue;
        const max = typeof issue.maximum === 'bigint' ? Number(issue.maximum) : issue.maximum;
        if (typeof max !== 'number' || !Number.isFinite(max)) continue;
        clampAtPath(clone, issue.path, max);
        clampedPaths.push(`${issue.path.join('.') || '<root>'}→${max}`);
    }

    if (clampedPaths.length > 0) {
        // Cheap signal that a salvage happened, so a recurring overrun (a prompt
        // that needs tightening) is visible rather than silent.
        console.warn(`[case-study] clamped ${clampedPaths.length} oversized field(s): ${clampedPaths.join(', ')}`);
    }

    return clone;
}
