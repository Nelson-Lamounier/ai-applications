/**
 * @format
 * stripDocumentSections — trim the grounding-verifier's input to what it
 * actually judges.
 *
 * The verifier receives the whole strategist XML as `answer`, but the
 * tailored resume JSON and the cover letter have their own dedicated guards
 * (resume-guard, number-provenance, cover-letter-guard). Re-judging them here
 * inflated the verifier input (~35K tokens observed live) AND risked a false
 * NOT_GROUNDED from resume phrasing — which, in block mode, replaces the
 * entire analysis with a one-line fallback. Pure + total.
 */
export function stripDocumentSections(xml: string): string {
	return xml
		.replace(
			/<tailored_resume_json><!\[CDATA\[[\s\S]*?\]\]><\/tailored_resume_json>/g,
			'<tailored_resume_json omitted="separately-guarded"/>',
		)
		.replace(
			/<cover_letter><!\[CDATA\[[\s\S]*?\]\]><\/cover_letter>/g,
			'<cover_letter omitted="separately-guarded"/>',
		);
}
