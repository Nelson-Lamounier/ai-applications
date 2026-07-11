/**
 * @format
 * Shared prompt rule for every pass that may rewrite resume text.
 *
 * Observed live (run a428bdf4): a refinement pass upgraded "authored the ROI
 * analysis ... pending security review" into "ROI analysis adopted for
 * regional and global rollout", and added scope words ("worldwide") absent
 * from the writer's grounded text. Guards exist to protect truthfulness —
 * they must never be the pass that inflates a claim.
 */
export const CLAIM_STRENGTH_RULE =
	'CLAIM STRENGTH IS FROZEN: never change the status or strength of any claim. ' +
	'A proposal stays a proposal; "pending review" stays pending; "planned" stays planned — ' +
	'never upgrade to adopted/approved/deployed/achieved/rolled out. ' +
	'Never add scope or scale words the input text does not contain (e.g. "worldwide", "global", "enterprise-scale").';
