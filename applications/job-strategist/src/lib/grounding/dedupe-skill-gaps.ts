/**
 * @format
 * dedupeSkillGaps — one gap row per real-world skill.
 *
 * The matcher (LLM) can emit the same requirement several ways — observed
 * live on the Meta run: 'PHP/Hack', 'PHP' and 'Hack' as three separate gaps.
 * Deterministic cleanup, applied after the reconcile chain:
 *   1. a compound gap ('A/B') is dropped when every part is already listed
 *      as its own gap (canonically);
 *   2. alias duplicates merge onto their canonical, keeping the most severe
 *      verdict (blocking > significant > minor; isDisqualifying ORed).
 * Pure + total; unknown skills pass through untouched.
 */
import type { SkillGap } from '@bedrock/shared';

const SEVERITY_RANK: Record<string, number> = { minor: 0, significant: 1, blocking: 2 };

function canon(skill: string, aliasToCanonical: ReadonlyMap<string, string>): string {
	const norm = skill.trim().toLowerCase();
	return aliasToCanonical.get(norm) ?? norm;
}

function moreSevere(a: SkillGap, b: SkillGap): SkillGap {
	return (SEVERITY_RANK[b.impactSeverity?.toLowerCase() ?? ''] ?? 0) > (SEVERITY_RANK[a.impactSeverity?.toLowerCase() ?? ''] ?? 0) ? b : a;
}

export function dedupeSkillGaps(
	gaps: readonly SkillGap[],
	aliasToCanonical: ReadonlyMap<string, string>,
	onRemoved?: (d: { removed: number }) => void,
): SkillGap[] {
	const canonicals = new Set(gaps.map((g) => canon(g.skill, aliasToCanonical)));

	// 1. Drop compounds fully covered by their parts.
	const withoutCoveredCompounds = gaps.filter((g) => {
		const parts = g.skill.split('/').map((p) => canon(p, aliasToCanonical)).filter((p) => p.length > 0);
		if (parts.length < 2) return true;
		return !parts.every((p) => canonicals.has(p));
	});

	// 2. Merge canonical duplicates, keeping order of first appearance.
	const byCanonical = new Map<string, SkillGap>();
	for (const g of withoutCoveredCompounds) {
		const key = canon(g.skill, aliasToCanonical);
		const existing = byCanonical.get(key);
		byCanonical.set(key, existing ? moreSevere(existing, g) : g);
	}

	const out = [...byCanonical.values()];
	const removed = gaps.length - out.length;
	if (removed > 0) onRemoved?.({ removed });
	return out;
}
