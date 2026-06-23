/**
 * @format
 * The JD's ATS keyword universe — the single source of truth scored by the
 * grounded ATS check AND shown to the free writer, so it optimises for exactly
 * what it is measured on (no drift). Union of the JD's required skills, tools,
 * and retrieval keywords (deduped, trimmed, non-empty).
 */
import type { JdSignal } from '@bedrock/shared';

export function jdAtsKeywords(
    jd: Pick<JdSignal, 'requiredSkills' | 'tools' | 'retrievalKeywords'>,
): string[] {
    return Array.from(
        new Set([...jd.requiredSkills, ...jd.tools, ...jd.retrievalKeywords].map((s) => s.trim()).filter((s) => s.length > 0)),
    );
}
