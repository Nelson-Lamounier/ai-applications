/** @format */
import { mkResult, allowedIds, allowedProjectIds } from '../graders.js';
import type { Grader } from '../graders.js';
import type { SkillTransferEntry } from '@bedrock/shared';

/**
 * Core grounding axis. Every emitted citation must trace to a real candidate id
 * surfaced in the candidate block, and every JD skill in the block must have an
 * entry. Invented ids/projectIds are the failure this guards against.
 */
export const groundingGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const ids = allowedIds(input.candidateSets);
    const projIds = allowedProjectIds(input.candidateSets);
    const skillsInBlock = new Set(input.candidateSets.map(s => s.jdSkill));
    const entries = (output.skillTransfer ?? []) as SkillTransferEntry[];

    const covered = new Set(entries.map(e => e.jdSkill));
    for (const skill of skillsInBlock) {
        if (!covered.has(skill)) failures.push(`no skillTransfer entry for JD skill: ${skill}`);
    }

    for (const e of entries) {
        if (e.tier === 'gap') continue; // gap shape checked by honesty-grader
        if (e.projectId != null && !projIds.has(e.projectId)) {
            failures.push(`invented projectId "${e.projectId}" for ${e.jdSkill}`);
        }
        for (const r of e.evidenceRefs) {
            if (!ids.has(r.id)) failures.push(`invented evidenceRef id "${r.id}" for ${e.jdSkill}`);
        }
    }

    return mkResult('grounding', failures);
};
