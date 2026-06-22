/**
 * @format
 * Deterministic ATS keyword coverage for the free tier — which JD keywords
 * landed in the generated resume, synonym-aware via the skill-ontology alias
 * map. No LLM: the writer only used evidence-backed keywords, so this is pure
 * string matching over what it produced. NOT the verified/partial/gap ledger.
 */
export interface AtsCoverage {
	readonly covered: string[];
	readonly missing: string[];
	readonly coverageRate: number; // 0..1; 1 when there are no JD keywords
}

const canon = (term: string, aliasToCanonical: ReadonlyMap<string, string>): string => {
	const lower = term.trim().toLowerCase().replace(/^[^a-z0-9+#]*|[^a-z0-9+#]*$/g, '');
	return aliasToCanonical.get(lower) ?? lower;
};

export function groundedAtsCoverage(
	resumeText: string,
	jdKeywords: readonly string[],
	aliasToCanonical: ReadonlyMap<string, string>,
): AtsCoverage {
	if (jdKeywords.length === 0) return { covered: [], missing: [], coverageRate: 1 };

	// Canonicalise every word in the resume once.
	// The dot in the regex keeps dotted tokens like Node.js and .NET intact after canonicalisation.
	const resumeCanon = new Set(
		(resumeText.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical)),
	);

	const covered: string[] = [];
	const missing: string[] = [];
	for (const kw of jdKeywords) {
		// A multi-word keyword is covered if every significant token canonicalises into the resume.
		const tokens = (kw.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => canon(w, aliasToCanonical));
		const hit = tokens.length > 0 && tokens.every((t) => resumeCanon.has(t));
		(hit ? covered : missing).push(kw);
	}
	return { covered, missing, coverageRate: covered.length / jdKeywords.length };
}
