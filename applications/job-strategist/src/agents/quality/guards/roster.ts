/**
 * @format
 * Experience roster invariant (deterministic): no pass may REMOVE an
 * experience role.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import type { ResumeViolation } from './types.js';
import { nameVariants } from './text.js';

type ExperienceEntry = StructuredResumeData['experience'][number];

/** A before-role is present in `after` when a role shares its title or a company name variant. */
function rosterHasRole(after: ReadonlyArray<ExperienceEntry>, role: ExperienceEntry): boolean {
    const title = role.title.trim().toLowerCase();
    const companyVariants = new Set(nameVariants(role.company));
    return after.some((e) => {
        if (e.title.trim().toLowerCase() === title) return true;
        return nameVariants(e.company).some((v) => companyVariants.has(v));
    });
}

/**
 * No pass may REMOVE an experience role. Every mutating LLM pass (guard
 * rewrite, condense, expand, reframe, surface-keywords) returns a full resume
 * JSON, and Haiku was observed dropping a whole role while "fixing" other
 * issues (run 8830a239 lost Meta via Accenture). Matching is rename-tolerant
 * (title OR company-variant overlap) because repairs legitimately relabel
 * companies (e.g. the solo-platform framing). Dropped roles are reinserted
 * verbatim at their original index.
 */
export function preserveExperienceRoster(
    before: StructuredResumeData,
    after: StructuredResumeData,
    onViolation?: (v: ResumeViolation) => void,
): StructuredResumeData {
    const beforeRoles = before.experience ?? [];
    const merged = [...(after.experience ?? [])];
    let changed = false;
    beforeRoles.forEach((role, idx) => {
        if (rosterHasRole(merged, role)) return;
        merged.splice(Math.min(idx, merged.length), 0, role);
        changed = true;
        onViolation?.({ code: 'experience_role_dropped', detail: `A rewrite pass removed the "${role.title}" role at "${role.company}" — reinserted verbatim. Every career-history role must appear on the resume.` });
    });
    return changed ? { ...after, experience: merged } : after;
}

/**
 * Restore a pre-weave experience snapshot onto a resume some later pass may
 * have rewritten. The metric weave (surfaceMetrics, run-pipeline.ts) rewrites
 * bullets across the WHOLE resume -- including experience, which it may
 * legitimately touch for a plain writer-authored resume. But once a
 * dedicated experience agent has authored the section, experience is
 * agent-owned: its bullets are provenance-guarded (every one traces to a
 * real career-history line) and the weave has no such guard. Scope the
 * weave's write surface to everything EXCEPT experience by snapshotting it
 * before the weave call and restoring it after -- the weave itself is not
 * retired, it still legitimately rewrites project descriptions. Pure.
 */
export function restoreExperienceAfter(
    resume: StructuredResumeData,
    before: StructuredResumeData['experience'],
): StructuredResumeData {
    return { ...resume, experience: before };
}
