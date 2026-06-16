/** @format */
import type { Pool } from 'pg';
import { RdsProjectEvidenceRepository, formatProjectEvidence, log } from '@bedrock/shared';

/**
 * Load + format the user's documented project case studies into a prompt block
 * (name, pitch, stack, key decisions, tags) for grounding resume bullets and
 * analysis in real, citeable project work.
 *
 * Fail-open: project evidence is additive, so any failure returns '' and the
 * pipeline proceeds on KB + career evidence as before.
 */
export async function loadProjectEvidenceBlock(pool: Pool, userId: string): Promise<string> {
    try {
        const evidence = await new RdsProjectEvidenceRepository(pool).load(userId);
        const block = formatProjectEvidence(evidence);
        log('INFO', 'Project evidence loaded', {
            agent: 'strategist',
            projects: evidence.projects.length,
            blockKb: block.length > 0 ? (block.length / 1024).toFixed(1) : 'empty',
        });
        return block;
    } catch (e) {
        log('WARN', 'project evidence load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return '';
    }
}

/**
 * Documented-project index for source-lane classification: the project names,
 * matched against evidence prose to credit the PROJECT lane (written case-study
 * context corroborating code-grounded REPO evidence). Fail-open to an empty
 * index — lane provenance is additive and must never block the pipeline.
 */
export async function loadProjectLaneIndex(
    pool: Pool,
    userId: string,
): Promise<{ projectNames: string[] }> {
    try {
        const evidence = await new RdsProjectEvidenceRepository(pool).load(userId);
        const projectNames: string[] = [];
        for (const p of evidence.projects) {
            if (p.name) projectNames.push(p.name);
        }
        return { projectNames };
    } catch (e) {
        log('WARN', 'project lane index load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return { projectNames: [] };
    }
}
