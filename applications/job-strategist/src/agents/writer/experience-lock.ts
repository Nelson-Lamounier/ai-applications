/** @format */
/**
 * Experience section lock -- ENFORCE (not merely detect) that no downstream
 * pass mutates the agent-owned, provenance-guarded Experience section.
 *
 * Before this, `job_strategist_section_net_fired_total{section="experience"}`
 * was a tripwire: it counted a downstream pass (guard/length/reframe/weave/
 * revalidate/surface-keywords) rewriting a bullet within a role that survived
 * `preserveExperienceRoster` (roster preservation only stops a whole ROLE
 * being dropped, not a bullet being rewritten), but never reverted the
 * rewrite. This helper closes that gap: every wrapped pass gets its Experience
 * snapshot restored byte-for-byte the moment it diverges, so Experience is
 * provably immutable once `fillResumeExperience` has produced it -- every
 * bullet on the FINAL resume traces to the agent's provenance-checked output,
 * never a downstream repair rewrite.
 *
 * Comparison is `JSON.stringify` of the `experience` array -- order-sensitive,
 * byte-level. Any divergence (a dropped role, a reworded bullet, a reordered
 * array) counts as a mutation and triggers a full restore, not a merge.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import { restoreExperienceAfter } from '../quality/guards/roster.js';

/**
 * Run `fn` over `resume`, then restore the pre-call Experience snapshot if
 * `fn` changed it. `onRestored(passName)` fires only on an actual restore --
 * callers use it to record the metric increment + violation-log entry for
 * that pass. `fn` is NOT caught here -- a throwing `fn` rejects `
 * withExperienceLock` too; callers keep their own fail-open `.catch`.
 */
export async function withExperienceLock(
    resume: StructuredResumeData,
    passName: string,
    fn: (r: StructuredResumeData) => Promise<StructuredResumeData>,
    onRestored: (pass: string) => void,
): Promise<StructuredResumeData> {
    const before = structuredClone(resume.experience);
    const out = await fn(resume);
    if (JSON.stringify(out.experience) === JSON.stringify(before)) return out;
    onRestored(passName);
    return restoreExperienceAfter(out, before);
}
