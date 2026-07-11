/**
 * @format
 * Per-role experience bullet cap — the deterministic guarantee that no
 * experience entry exceeds `max` highlights. The writer persona orders each
 * role's bullets by JD relevance, so keeping the FIRST `max` keeps the most
 * relevant. Pure + total: a role with <= max (or missing) highlights is
 * returned unchanged; never pads, never throws, never mutates the input.
 */
export function capHighlights<T extends { highlights?: string[] }>(
	experience: readonly T[],
	max = 5,
): T[] {
	return experience.map((e) => ({ ...e, highlights: (e.highlights ?? []).slice(0, max) }));
}
