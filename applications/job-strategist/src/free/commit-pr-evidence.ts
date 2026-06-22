/**
 * @format
 * Free-tier commit/PR evidence — the candidate's own shipped work from
 * repo_commits / repo_pull_requests (populated by ingestion; pure DB read, no
 * GitHub network, no LLM). PR titles are conventional-commit, impact-describing
 * and read as ready-made resume bullets. Authored-only: commits are filtered to
 * the user's dominant author_login so the writer can claim them first-person.
 * Fail-open to '' so a thin/absent history never blocks generation.
 */
import type { Pool } from 'pg';

const PR_CAP = 8;
const COMMIT_CAP = 12;

interface PrRow { repo_full_name: string; number: number; title: string }
interface CommitRow { repo_full_name: string; message: string }

export async function loadCommitPrEvidence(pool: Pool, userId: string): Promise<string> {
    try {
        // Recent merged PRs first (open/unmerged last); these are the user's own
        // repos so they are the user's PRs.
        const pulls = (await pool.query<PrRow>(
            `SELECT repo_full_name, number, title
               FROM repo_pull_requests
              WHERE user_id = $1
              ORDER BY merged_at DESC NULLS LAST
              LIMIT $2`,
            [userId, PR_CAP],
        )).rows;

        // Commits by the dominant author_login (the user), longest/most-recent
        // messages first; skip ambiguous co-author/bot commits.
        const commits = (await pool.query<CommitRow>(
            `SELECT repo_full_name, message
               FROM repo_commits
              WHERE user_id = $1
                AND author_login = (
                    SELECT author_login FROM repo_commits
                     WHERE user_id = $1 AND author_login IS NOT NULL
                     GROUP BY author_login ORDER BY count(*) DESC LIMIT 1)
              ORDER BY authored_at DESC
              LIMIT $2`,
            [userId, COMMIT_CAP],
        )).rows;

        if (pulls.length === 0 && commits.length === 0) return '';

        const lines: string[] = ['Shipped work (the candidate\'s own pull requests & commits — citable evidence):'];
        for (const p of pulls) lines.push(`- ${p.repo_full_name}: PR "${p.title}" (#${p.number})`);
        for (const c of commits) lines.push(`- ${c.repo_full_name}: commit "${c.message.split('\n')[0]}"`);
        return lines.join('\n');
    } catch {
        return '';
    }
}
