/** @format */
import type { Pool } from 'pg';
import { RdsProjectEvidenceRepository, formatProjectEvidence, log } from '@bedrock/shared';
import { withUserRls } from '../lib/rls.js';

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
 * Load the per-project, per-angle tailored resume bullets (written by the
 * case-study pipeline into `project_resume_bullets`) into a prompt block the
 * Strategist SELECTS from when filling each `projects[].highlights` array.
 *
 * These are the strongest, already-grounded technical bullets the platform
 * produces — the writer must quote/lightly-trim from here rather than
 * re-summarising the case-study prose (which lost this signal historically).
 *
 * Angles are grouped under each project so the writer can pick the set(s)
 * matching the JD archetype. Fail-open: returns '' on any error so the
 * pipeline proceeds on the case-study prose as before.
 */
export async function loadProjectResumeBulletsBlock(pool: Pool, userId: string): Promise<string> {
    try {
        // project_resume_bullets carries per-user RLS keyed on the
        // `app.current_user_id` GUC. Under pgbouncer transaction-pooling a bare
        // pool.query lands on a connection with no (or a stale) context, so RLS
        // silently matches 0 rows — the bullets never reach the writer. Run
        // inside withUserRls so the GUC is set in the SAME transaction (see
        // lib/rls.ts), exactly like the other per-user reads.
        const { rows } = await withUserRls(pool, userId, (client) =>
            client.query<{ name: string; angle: string; bullets: unknown }>(
                `SELECT p.name, prb.angle, prb.bullets
                   FROM project_resume_bullets prb
                   JOIN projects p ON p.id = prb.project_id
                  WHERE prb.user_id = $1
                  ORDER BY p.name, prb.angle`,
                [userId],
            ),
        );
        if (rows.length === 0) return '';

        const byProject = new Map<string, string[]>();
        for (const r of rows) {
            const bullets = Array.isArray(r.bullets)
                ? (r.bullets as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
                : [];
            if (bullets.length === 0) continue;
            const lines = byProject.get(r.name) ?? [];
            lines.push(`[angle: ${r.angle}]`);
            for (const b of bullets) lines.push(`- ${b.trim()}`);
            byProject.set(r.name, lines);
        }
        if (byProject.size === 0) return '';

        const block = Array.from(byProject.entries())
            .map(([name, lines]) => [`## ${name}`, ...lines].join('\n'))
            .join('\n\n');

        log('INFO', 'Project resume bullets loaded', {
            agent: 'strategist',
            projects: byProject.size,
            angleSets: rows.length,
            blockKb: (block.length / 1024).toFixed(1),
        });
        return block;
    } catch (e) {
        log('WARN', 'project resume bullets load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
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
): Promise<{ projectNames: string[]; projectPitches: Array<{ name: string; pitch: string }> }> {
    try {
        const evidence = await new RdsProjectEvidenceRepository(pool).load(userId);
        const projectNames: string[] = [];
        const projectPitches: Array<{ name: string; pitch: string }> = [];
        for (const p of evidence.projects) {
            if (!p.name) continue;
            projectNames.push(p.name);
            const pitch = p.pitch ?? p.tagline ?? '';
            if (pitch) projectPitches.push({ name: p.name, pitch });
        }
        return { projectNames, projectPitches };
    } catch (e) {
        log('WARN', 'project lane index load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return { projectNames: [], projectPitches: [] };
    }
}
