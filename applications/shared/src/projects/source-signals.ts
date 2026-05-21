/**
 * @format
 * Helpers around the `source_signals` evidence JSONB. Validation is the
 * Zod schema in `case-study-types.ts`; this file adds the two utilities
 * the orchestrator and persistence layers actually need:
 *
 *   - `computeContentHash` — stable hash over evidence + the content
 *     fields it justifies. Used as the dedup key on every per-section
 *     write so re-running case-study generation never inserts duplicate
 *     decisions / highlights / challenges.
 *   - `mergeGroundingResult` — fold a `BedrockGroundingVerifier` result
 *     into the SourceSignal so a downstream UI can show "verifier flagged
 *     N claims" without re-running grounding.
 */
import { createHash } from 'node:crypto';

import type { GroundingResult } from '../grounding/grounding-types.js';

import type { SourceSignal } from './case-study-types.js';

function canonicalString(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(canonicalString).join('');
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return Object.keys(obj)
            .sort()
            .map((k) => `${k}=${canonicalString(obj[k])}`)
            .join('');
    }
    return String(value);
}

/**
 * Hex-encoded SHA-256 over the concatenation of `content` plus a
 * canonicalised representation of `signals`. Stable across runs and
 * languages — the persistence layer relies on collisions only when the
 * model emits genuinely identical evidence.
 *
 * For multi-section rows (decisions / highlights / etc.) the caller is
 * expected to pass every relevant content field so two decisions with
 * the same title but different `consequences` hash differently.
 */
export function computeContentHash(
    content: ReadonlyArray<string | null | undefined>,
    signals: SourceSignal,
): string {
    const h = createHash('sha256');
    for (const part of content) {
        h.update(part ?? '');
        h.update('');
    }
    h.update(canonicalString({
        commits: signals.commits.map((c) => ({ repo: c.repoFullName, sha: c.sha })),
        files:   signals.files.map((f) => ({ repo: f.repoFullName, path: f.path })),
    }));
    return h.digest('hex');
}

/**
 * Pin a verifier outcome onto the signal. Always returns a copy so callers
 * can keep the original around for diffing if needed.
 */
export function mergeGroundingResult(
    signal: SourceSignal,
    result: GroundingResult,
): SourceSignal {
    return {
        ...signal,
        grounding:        result.status,
        ungroundedClaims: [...result.ungroundedClaims],
    };
}

/**
 * Concatenation of the model output's contextChunks. Used as the
 * `contextChunks` field on the grounding call so the verifier sees the
 * same evidence the model claimed to use.
 */
export function flattenSignalToContext(signal: SourceSignal): readonly string[] {
    return [
        ...signal.commits.map((c) => `[${c.sha.slice(0, 8)} ${c.repoFullName}] ${c.message}`),
        ...signal.files.map((f) => `[${f.repoFullName}:${f.path}]`),
    ];
}
