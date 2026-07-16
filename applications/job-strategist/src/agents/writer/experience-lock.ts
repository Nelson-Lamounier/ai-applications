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

/**
 * Projects[].description lock -- the Task 2 sibling of `withExperienceLock`,
 * ENFORCING (not merely detecting) that no downstream pass rewrites the
 * deterministic pitch stamp (`stampProjectDescription`,
 * projects-description.ts) once it has been set. Unlike the experience lock
 * (whole-section, byte-for-byte), this lock is scoped to ONE field --
 * `description` -- so a pass may still freely rewrite `highlights` or add
 * `github`; only a changed description gets reverted, entry by entry.
 *
 * Entries are matched `before` -> `after` primarily by `name` (a rewrite
 * pass returns the full resume JSON and could plausibly reorder the array
 * without renaming anything); an entry whose name is not found in the
 * `before` snapshot falls back to matching by array index. An `after` entry
 * with no match at either (a genuinely new entry some pass added) is left
 * alone -- there is no snapshot to restore it from.
 *
 * `onRestored(passName)` fires at most once per call, only when at least one
 * entry's description was actually reverted -- callers use it to record the
 * metric increment + violation-log entry for that pass, mirroring
 * `withExperienceLock`. `fn` is NOT caught here -- a throwing `fn` rejects
 * `withProjectsDescriptionLock` too; callers keep their own fail-open
 * `.catch`.
 */
export async function withProjectsDescriptionLock(
    resume: StructuredResumeData,
    passName: string,
    fn: (r: StructuredResumeData) => Promise<StructuredResumeData>,
    onRestored: (pass: string) => void,
): Promise<StructuredResumeData> {
    const before = resume.projects ?? [];
    const beforeByName = new Map(before.map((p) => [p.name, p.description]));
    const out = await fn(resume);
    const after = out.projects ?? [];

    let restored = false;
    const projects = after.map((entry, idx) => {
        const beforeDescription = beforeByName.has(entry.name) ? beforeByName.get(entry.name) : before[idx]?.description;
        if (beforeDescription === undefined || beforeDescription === entry.description) return entry;
        restored = true;
        return { ...entry, description: beforeDescription };
    });

    if (!restored) return out;
    onRestored(passName);
    return { ...out, projects };
}
