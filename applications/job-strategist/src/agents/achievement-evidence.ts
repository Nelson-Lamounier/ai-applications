/**
 * @format
 * Achievement & impact evidence — the specific, grounded material that makes a
 * cover letter concrete instead of generic. Pure DB read (no LLM) of the user's
 * project_challenges (problem -> solution), project_decisions
 * (decision -> consequence == impact) and project_highlights (achievements).
 * Fail-open to '' so a user with no case study still generates a letter from
 * career/commit-PR/KB evidence.
 */
import type { Pool } from 'pg';

const CHALLENGE_CAP = 4;
const DECISION_CAP = 4;
const HIGHLIGHT_CAP = 4;

interface ChallengeRow {
	problem: string;
	solution: string;
}
interface DecisionRow {
	decision: string;
	consequences: string;
}
interface HighlightRow {
	title: string;
	description: string;
}

export async function loadAchievementEvidence(pool: Pool, userId: string): Promise<string> {
	try {
		const [challenges, decisions, highlights] = await Promise.all([
			pool.query<ChallengeRow>(
				`SELECT problem, solution FROM project_challenges WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
				[userId, CHALLENGE_CAP],
			),
			pool.query<DecisionRow>(
				`SELECT decision, consequences FROM project_decisions WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
				[userId, DECISION_CAP],
			),
			pool.query<HighlightRow>(
				`SELECT title, description FROM project_highlights WHERE user_id = $1 ORDER BY order_index LIMIT $2`,
				[userId, HIGHLIGHT_CAP],
			),
		]);

		const groups: string[] = [];
		if (challenges.rows.length > 0) {
			groups.push(
				'Challenges overcome (problem -> how it was solved):\n' +
					challenges.rows.map((r) => `- ${r.problem} -> ${r.solution}`).join('\n'),
			);
		}
		if (decisions.rows.length > 0) {
			groups.push(
				'Decision impact (decision -> consequence; pick those relevant to the role):\n' +
					decisions.rows.map((r) => `- ${r.decision} -> ${r.consequences}`).join('\n'),
			);
		}
		if (highlights.rows.length > 0) {
			groups.push(
				'Achievements:\n' +
					highlights.rows.map((r) => `- ${r.title} — ${r.description}`).join('\n'),
			);
		}
		return groups.join('\n\n');
	} catch {
		return '';
	}
}
