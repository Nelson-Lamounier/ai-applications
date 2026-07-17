/**
 * @format
 * buildInlineStampInputs — pure query composition, no live Postgres.
 *
 * `pool` is a recording fake that routes by SQL substring, mirroring
 * run-facts-stage.test.ts's fakePool pattern.
 */
import { describe, it, expect, jest } from '@jest/globals';

import { buildInlineStampInputs } from './inline-stamp.js';

interface Route { readonly needle: string; readonly rows: unknown[] }

function fakePool(routes: Route[] = []) {
    const calls: string[] = [];
    const respond = (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        calls.push(normalized);
        const hit = routes.find((r) => normalized.includes(r.needle));
        return { rows: hit ? hit.rows : [] };
    };
    const pool = { query: jest.fn(async (sql: string) => respond(sql)) };
    return { pool, calls };
}

const LOGIN_ROUTE: Route = { needle: 'FROM oauth_connections', rows: [{ username: 'octocat' }] };

describe('buildInlineStampInputs', () => {
    it('builds an authored, owner-is-user stamp with per-file tech when all signals hit', async () => {
        const { pool } = fakePool([
            LOGIN_ROUTE,
            { needle: 'FROM repository_profiles', rows: [{ classification: 'project', quality_score: 0.8 }] },
            { needle: 'FROM repo_commits', rows: [{ n: '3' }] },
            {
                needle: 'FROM technology_evidence',
                rows: [
                    { file_path: 'src/index.ts', tech: ['typescript', 'node.js'] },
                    { file_path: 'Dockerfile', tech: ['docker'] },
                ],
            },
        ]);

        const result = await buildInlineStampInputs(pool as never, 'u1', 'octocat/repo');

        expect(result.repoStamp).toEqual({
            is_fork:             false,
            repo_classification: 'project',
            repo_confidence:     0.8,
            authored:            true,
            role_inferred:       false,
            owner_is_user:       true,
            repo_tech_stack:     ['docker', 'node.js', 'typescript'],
            repo_domain:         null,
        });
        expect(result.fileTechMap.get('src/index.ts')).toEqual(['typescript', 'node.js']);
        expect(result.fileTechMap.get('Dockerfile')).toEqual(['docker']);
        expect(result.fileTechMap.has('unknown.rb')).toBe(false);
    });

    it('marks role_inferred (not authored) when the repo is a fork, even with commits', async () => {
        const { pool } = fakePool([
            LOGIN_ROUTE,
            { needle: 'FROM repository_profiles', rows: [{ classification: 'fork', quality_score: 0.5 }] },
            { needle: 'FROM repo_commits', rows: [{ n: '1' }] },
            { needle: 'FROM technology_evidence', rows: [] },
        ]);

        const result = await buildInlineStampInputs(pool as never, 'u1', 'someoneelse/repo');

        expect(result.repoStamp.is_fork).toBe(true);
        expect(result.repoStamp.authored).toBe(false);
        expect(result.repoStamp.role_inferred).toBe(true);
        expect(result.fileTechMap.size).toBe(0);
    });

    it('defaults classification/confidence and skips authorship when no profile/login/commits exist', async () => {
        const { pool } = fakePool([
            { needle: 'FROM oauth_connections', rows: [] },
            { needle: 'FROM repository_profiles', rows: [] },
            { needle: 'FROM technology_evidence', rows: [] },
        ]);

        const result = await buildInlineStampInputs(pool as never, 'u1', 'octocat/repo');

        expect(result.repoStamp.repo_classification).toBe('unknown');
        expect(result.repoStamp.repo_confidence).toBe(0);
        expect(result.repoStamp.owner_is_user).toBe(false);
        expect(result.repoStamp.authored).toBe(false);
        expect(result.repoStamp.role_inferred).toBe(true);
        expect(result.repoStamp.repo_tech_stack).toEqual([]);
    });

    it('scopes every query to the given repoFullName, not the user\'s whole corpus', async () => {
        const { pool, calls } = fakePool([
            LOGIN_ROUTE,
            { needle: 'FROM repository_profiles', rows: [{ classification: 'project', quality_score: 1 }] },
            { needle: 'FROM repo_commits', rows: [{ n: '1' }] },
            { needle: 'FROM technology_evidence', rows: [] },
        ]);

        await buildInlineStampInputs(pool as never, 'u1', 'octocat/repo');

        const profileCall = calls.find((c) => c.includes('FROM repository_profiles'));
        expect(profileCall).toMatch(/WHERE user_id = \$1 AND repo_full_name = \$2/);
        const commitsCall = calls.find((c) => c.includes('FROM repo_commits'));
        expect(commitsCall).toMatch(/WHERE user_id = \$1 AND repo_full_name = \$2/);
        const techCall = calls.find((c) => c.includes('FROM technology_evidence'));
        expect(techCall).toMatch(/WHERE te\.user_id = \$1 AND te\.repo_full_name = \$2/);
    });
});
