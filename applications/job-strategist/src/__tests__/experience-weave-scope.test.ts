/**
 * @format
 * restoreExperienceAfter: the metric-weave (surfaceMetrics) rewrites the
 * whole resume, but experience is agent-owned (fillResumeExperience already
 * produced the provenance-guarded final section) -- the weave must never
 * touch it. Scope the weave's write surface to everything else by
 * snapshotting experience before the weave and restoring it after, without
 * disturbing any other field the weave legitimately changed. (Task 2:
 * `projects[].description` is now ALSO locked downstream, via the sibling
 * `withProjectsDescriptionLock`, experience-lock.ts -- but that is a
 * SEPARATE, field-scoped lock; this test exercises only the
 * `restoreExperienceAfter` mechanics `withExperienceLock` uses.)
 *
 * Imported from agents/quality/resume-guard.js (its real home, alongside the
 * sibling preserveExperienceRoster invariant) rather than run-pipeline.js:
 * run-pipeline.ts's module graph transitively pulls in pdf-parse ->
 * @napi-rs/canvas (ATS PDF render/parse-back), whose native binding leaves
 * an open GC handle Jest cannot tear down -- confirmed via
 * `jest --detectOpenHandles` before this file settled on the lightweight
 * import. run-pipeline.ts itself imports restoreExperienceAfter from the
 * same resume-guard.js module used here.
 */
import { describe, it, expect } from '@jest/globals';
import type { StructuredResumeData } from '@bedrock/shared';
import { restoreExperienceAfter } from '../agents/quality/resume-guard.js';

function baseResume(): StructuredResumeData {
    return {
        profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Remote' },
        summary: 'A platform engineer.',
        experience: [
            { company: 'AWS', title: 'Support Engineer', period: '2023-2025', highlights: ['original bullet'] },
        ],
        skills: [{ category: 'Cloud', skills: ['AWS'] }],
        education: [],
        certifications: [],
        projects: [{ name: 'Tucaken', description: 'before weave', highlights: ['h1'], github: 'https://x' }],
        keyAchievements: [],
    };
}

describe('restoreExperienceAfter', () => {
    it('restores experience byte-identically after the weave, leaving the weave\'s other changes (e.g. projects) intact', () => {
        const before = structuredClone(baseResume().experience);
        const woven: StructuredResumeData = {
            ...baseResume(),
            experience: [
                { company: 'AWS', title: 'Support Engineer', period: '2023-2025', highlights: ['weave rewrote this bullet -- must not survive'] },
            ],
            projects: [{ name: 'Tucaken', description: 'weave-changed description', highlights: ['h1'], github: 'https://x' }],
        };

        const restored = restoreExperienceAfter(woven, before);

        expect(restored.experience).toEqual(before); // byte-identical to the pre-weave snapshot
        expect(restored.experience).not.toEqual(woven.experience); // the weave's rewrite did NOT survive
        expect(restored.projects).toEqual(woven.projects);
        expect(restored.summary).toBe(woven.summary);
    });

    it('is a pure snapshot-restore -- does not mutate the woven input', () => {
        const before = structuredClone(baseResume().experience);
        const woven = baseResume();
        const wovenSnapshot = structuredClone(woven);

        restoreExperienceAfter(woven, before);

        expect(woven).toEqual(wovenSnapshot);
    });
});
