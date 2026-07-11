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
