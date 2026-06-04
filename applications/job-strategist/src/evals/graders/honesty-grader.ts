/** @format */
import { validateSkillTransfer } from '@bedrock/shared';
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { SkillTransferEntry } from '@bedrock/shared';

/**
 * Honesty tripwire. Runs the production validateSkillTransfer over the emitted
 * entries: on honest gold output it is a no-op, so any divergence means the model
 * invented a citation that runtime would have demoted to a gap. Known-skill entries
 * are compared by value; unknown-skill entries (which validate drops) are excluded
 * from the comparison set so the equality holds for honest output.
 */
export const honestyGrader: Grader = (input, output) => {
    const failures: string[] = [];
    const entries = (output.skillTransfer ?? []) as SkillTransferEntry[];
    const knownSkills = new Set(input.candidateSets.map(s => s.jdSkill));
    const known = entries.filter(e => knownSkills.has(e.jdSkill));
    const validated = validateSkillTransfer(entries, input.candidateSets);

    if (JSON.stringify(validated) !== JSON.stringify(known)) {
        failures.push('skillTransfer not honest: validateSkillTransfer demoted/dropped entries');
    }

    // Gap-shape: a gap must be a true gap (no project, no evidence). validateSkillTransfer
    // passes gap entries through unchanged, so it does NOT catch a malformed gap — enforce here.
    for (const e of entries) {
        if (e.tier !== 'gap') continue;
        if (e.projectId !== null) failures.push(`gap entry for "${e.jdSkill}" must have projectId=null, got "${e.projectId}"`);
        if (e.evidenceRefs.length > 0) failures.push(`gap entry for "${e.jdSkill}" must have empty evidenceRefs`);
    }

    return mkResult('honesty', failures);
};
