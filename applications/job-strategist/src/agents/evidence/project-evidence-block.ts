/** @format */
import type { Pool } from 'pg';
import { RdsProjectEvidenceRepository, formatProjectEvidence, log } from '@bedrock/shared';
import { withUserRls } from '../../lib/rls.js';

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
/** A documented project's flattened tailored bullets (all angles), for wiring + relocation. */
export interface ProjectResumeBulletSet {
    readonly name: string;
    /** All angle bullets flattened + de-duplicated, order-preserving. */
    readonly bullets: readonly string[];
}

/**
 * Structured variant of {@link loadProjectResumeBulletsBlock}: the tailored
 * bullets grouped per documented project (angles flattened + de-duplicated).
 * Used both to build the writer's prompt block AND to relocate any bullet the
 * writer mis-files under Experience back to the correct project.
 */
export async function loadProjectResumeBullets(pool: Pool, userId: string): Promise<ProjectResumeBulletSet[]> {
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

        const byProject = new Map<string, string[]>();
        const seen = new Map<string, Set<string>>();
        for (const r of rows) {
            const bullets = Array.isArray(r.bullets)
                ? (r.bullets as unknown[]).filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
                : [];
            if (bullets.length === 0) continue;
            const list = byProject.get(r.name) ?? [];
            const dedup = seen.get(r.name) ?? new Set<string>();
            for (const b of bullets) {
                const t = b.trim();
                const key = t.toLowerCase();
                if (!dedup.has(key)) { dedup.add(key); list.push(t); }
            }
            byProject.set(r.name, list);
            seen.set(r.name, dedup);
        }
        return Array.from(byProject.entries()).map(([name, bullets]) => ({ name, bullets }));
    } catch (e) {
        log('WARN', 'project resume bullets load failed (non-fatal)', { agent: 'strategist', error: (e as Error).message });
        return [];
    }
}

/** Format the per-project bullet sets into the writer prompt block. */
export function formatProjectResumeBulletsBlock(sets: ReadonlyArray<ProjectResumeBulletSet>): string {
    if (sets.length === 0) return '';
    const block = sets
        .map((s) => [`## ${s.name}`, ...s.bullets.map((b) => `- ${b}`)].join('\n'))
        .join('\n\n');
    log('INFO', 'Project resume bullets loaded', {
        agent: 'strategist',
        projects: sets.length,
        bullets: sets.reduce((n, s) => n + s.bullets.length, 0),
        blockKb: (block.length / 1024).toFixed(1),
    });
    return block;
}

/** Convenience: load + format in one call (writer prompt block). */
export async function loadProjectResumeBulletsBlock(pool: Pool, userId: string): Promise<string> {
    return formatProjectResumeBulletsBlock(await loadProjectResumeBullets(pool, userId));
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
