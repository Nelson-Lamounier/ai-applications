/**
 * @format
 * Deterministic evidence-fit score for the free tier — what fraction of the
 * JD's required/preferred skills the USER actually has evidence for, matched
 * against the gathered evidence corpus (code tech, career facts, projects,
 * KB passages, achievements), synonym-aware via the skill-ontology alias map.
 *
 * No LLM, no extra query: it is pure set intersection over data already loaded
 * by gatherFreeEvidence + the alias map already loaded for the ATS check, so it
 * adds ZERO marginal cost to the free pipeline.
 *
 * It scores the CANDIDATE (evidence side), not the generated resume — distinct
 * from groundedAtsCoverage, which scores the resume text. It is also NOT the
 * paid matcher's verified/partial/gap ledger: there is no `partial` verdict
 * (that needs the LLM's judgement), so this is honest binary "evidence present".
 */
import type { JdSignal } from '@bedrock/shared';

export interface EvidenceFit {
	/** Weighted blend of required (0.7) and preferred (0.3); 0..1. Headline score. */
	readonly overallFit: number;
	/** Fraction of the required universe (requiredSkills ∪ tools) backed by evidence; 0..1. */
	readonly requiredFit: number;
	/** Fraction of the preferred universe (preferredSkills ∪ concepts) backed by evidence; 0..1. */
	readonly preferredFit: number;
	readonly requiredCovered: string[];
	readonly requiredMissing: string[];
	readonly preferredCovered: string[];
	readonly preferredMissing: string[];
}

const REQUIRED_WEIGHT = 0.7;
const PREFERRED_WEIGHT = 0.3;

/** Canonicalise a single token — identical rule to grounded-coverage's `canon`. */
const canon = (term: string, aliasToCanonical: ReadonlyMap<string, string>): string => {
	const lower = term.trim().toLowerCase().replace(/^[^a-z0-9+#]*|[^a-z0-9+#]*$/g, '');
	return aliasToCanonical.get(lower) ?? lower;
};

/** Canonical token signature of a keyword (multi-word safe); '' when it has no significant tokens. */
const signature = (kw: string, aliasToCanonical: ReadonlyMap<string, string>): string =>
	(kw.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical)).join(' ');

interface GroupResult {
	readonly covered: string[];
	readonly missing: string[];
	readonly rate: number; // 0..1; 1 when the universe is empty (vacuously satisfied)
	readonly nonEmpty: boolean;
}

function scoreGroup(
	keywords: readonly string[],
	evidenceCanon: ReadonlySet<string>,
	aliasToCanonical: ReadonlyMap<string, string>,
): GroupResult {
	const covered: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>(); // dedup the universe by canonical signature

	for (const kw of keywords) {
		const sig = signature(kw, aliasToCanonical);
		if (sig.length === 0 || seen.has(sig)) continue;
		seen.add(sig);

		// Covered iff every significant token canonicalises into the evidence corpus.
		const hit = sig.split(' ').every((t) => evidenceCanon.has(t));
		(hit ? covered : missing).push(kw);
	}

	const total = covered.length + missing.length;
	return { covered, missing, rate: total === 0 ? 1 : covered.length / total, nonEmpty: total > 0 };
}

/**
 * Compute the evidence-fit score for a JD against the user's evidence corpus.
 *
 * @param jd            JD signal (required/preferred skills, tools, concepts).
 * @param evidenceText  Concatenated free-tier evidence (code tech + career +
 *                      projects + KB passages + achievements).
 * @param aliasToCanonical  Skill-ontology alias→canonical map (already loaded for ATS).
 */
export function evidenceFitScore(
	jd: Pick<JdSignal, 'requiredSkills' | 'tools' | 'preferredSkills' | 'concepts'>,
	evidenceText: string,
	aliasToCanonical: ReadonlyMap<string, string>,
): EvidenceFit {
	const evidenceCanon = new Set(
		(evidenceText.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical)),
	);

	const required = scoreGroup([...jd.requiredSkills, ...jd.tools], evidenceCanon, aliasToCanonical);
	const preferred = scoreGroup([...jd.preferredSkills, ...jd.concepts], evidenceCanon, aliasToCanonical);

	// Weight only the non-empty groups so a JD with no preferred skills scores on
	// required alone (and a JD with no signal at all scores a vacuous 1).
	const wReq = required.nonEmpty ? REQUIRED_WEIGHT : 0;
	const wPref = preferred.nonEmpty ? PREFERRED_WEIGHT : 0;
	const totalWeight = wReq + wPref;
	const overallFit = totalWeight === 0 ? 1 : (required.rate * wReq + preferred.rate * wPref) / totalWeight;

	return {
		overallFit,
		requiredFit: required.rate,
		preferredFit: preferred.rate,
		requiredCovered: required.covered,
		requiredMissing: required.missing,
		preferredCovered: preferred.covered,
		preferredMissing: preferred.missing,
	};
}
