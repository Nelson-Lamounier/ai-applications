/**
 * @format
 * Operations-angle theme ontology -- the deterministic bridge from JD text to
 * retrieval queries for the projects agent. A hand-curated, FIXED set (no LLM
 * theme derivation): each theme names a way a system is OPERATED (database
 * administration, backup/recovery, cluster orchestration, ...) rather than
 * what was built with it, closing the gap operations-flavoured JDs (e.g. a
 * MongoDB TSE role) expose in the case-study-angled projects pool.
 *
 * `activateThemes` is the sole entry point: it takes the JD's flattened,
 * TIER-TAGGED requirement/preferred/concept strings and returns the themes
 * whose `matchTerms` are demonstrated in that vocabulary, via the SHARED
 * `experienceTermMatch` predicate (no new matching logic here). Tiering
 * (docs/superpowers/specs/2026-07-16-projects-narrative-quality-design.md,
 * Component 1) makes a REQUIRED or DISQUALIFYING JD box decisive over
 * concept-accumulated themes: live run fe421faf ranked activation by raw hit
 * count alone and a required box (networking-protocols) lost the top-3 cut to
 * themes hit by several merely-preferred JD strings. Zero activations is
 * still the expected, common case -- the caller must treat that as a
 * complete no-op, fail-closed to today's behaviour.
 */
import { experienceTermMatch } from '../../ats/gate/experience-coverage.js';

export interface OperationsTheme {
	readonly key: string;
	readonly label: string;
	readonly queryTerms: string;
	readonly matchTerms: readonly string[];
	readonly kinds: readonly string[];
}

/**
 * One flattened JD string plus the JD-signal tier it came from. The caller
 * (`jdStringsForThemes`, operations-wiring.ts) is the sole place that maps
 * `JdSignal` fields onto tiers -- kept out of this module so the ontology and
 * scoring stay generic over ANY tier source.
 */
export interface TieredJdString {
	readonly text: string;
	readonly tier: 'disqualifying' | 'required' | 'preferred';
}

/** Per-hit scoring weight for each tier -- a disqualifying-tier hit outweighs
 *  a required-tier hit, which outweighs a preferred-tier hit. Sum-based (not
 *  max-based) so a theme repeatedly demonstrated in JD text still outranks a
 *  theme hit exactly once, at the same tier. */
const TIER_WEIGHT: Record<TieredJdString['tier'], number> = {
	disqualifying: 3,
	required: 2,
	preferred: 1,
};

const MAX_ACTIVATED_THEMES = 4;

/**
 * Seven entries, spec order preserved (docs/superpowers/specs/2026-07-16-
 * projects-operations-evidence-design.md, Component 1) -- also the tie-break
 * order when two or more themes hit the same number of distinct JD strings.
 */
export const OPERATIONS_THEMES: readonly OperationsTheme[] = [
	{
		key: 'database-operations',
		label: 'database operations',
		queryTerms: 'database operations connection pooling migrations schema backup production',
		matchTerms: ['database', 'databases', 'rdbms', 'nosql', 'mongodb', 'postgresql', 'sql'],
		kinds: ['backend', 'infra'],
	},
	{
		key: 'performance-tuning',
		label: 'performance tuning',
		queryTerms: 'performance tuning latency memory profiling optimisation benchmark',
		matchTerms: ['performance', 'tuning', 'latency', 'scalability', 'benchmarking'],
		kinds: ['backend', 'infra', 'ml'],
	},
	{
		key: 'storage',
		label: 'storage',
		queryTerms: 'storage volumes disks persistence caching multipath',
		matchTerms: ['storage', 'nas', 'san', 'ssd', 'caching', 'multi-pathing', 'volumes'],
		kinds: ['infra'],
	},
	{
		key: 'networking-protocols',
		label: 'networking protocols',
		queryTerms: 'networking dns tcp tls certificates ingress load balancer',
		matchTerms: ['networking', 'dns', 'tcp', 'tls', 'ssl', 'protocols'],
		kinds: ['infra', 'backend'],
	},
	{
		key: 'security-hardening',
		label: 'security hardening',
		queryTerms: 'security hardening authentication authorization rls iam policies',
		matchTerms: ['security', 'authentication', 'authorization', 'hardening', 'ldap', 'kerberos', 'iam'],
		kinds: ['infra', 'backend'],
	},
	{
		key: 'backup-recovery',
		label: 'backup recovery',
		queryTerms: 'backup restore recovery disaster failover snapshot',
		matchTerms: ['backup', 'recovery', 'restore', 'failover', 'disaster'],
		kinds: ['infra', 'backend'],
	},
	{
		key: 'cluster-orchestration',
		label: 'cluster orchestration',
		queryTerms: 'kubernetes cluster orchestration autoscaling operators nodes',
		matchTerms: ['kubernetes', 'cluster', 'clusters', 'orchestration', 'operators'],
		kinds: ['infra'],
	},
];

/** Sum of `TIER_WEIGHT[tier]` over DISTINCT `jdStrings` entries that
 *  demonstrate at least one of `theme.matchTerms` -- a theme's activation
 *  score. A jd string that matches more than one of the theme's `matchTerms`
 *  (e.g. "performance tuning" hits both `performance` and `tuning`) still
 *  counts once, at its own tier's weight. */
function scoreTheme(theme: OperationsTheme, jdStrings: readonly TieredJdString[]): number {
	return jdStrings
		.filter((jdString) => theme.matchTerms.some((matchTerm) => experienceTermMatch(matchTerm, jdString.text)))
		.reduce((sum, jdString) => sum + TIER_WEIGHT[jdString.tier], 0);
}

/**
 * `jdStrings` = the caller's flattened, tier-tagged `hardRequirements[].skill`
 * + preferred + concepts from `JdSignal` (kept pure here -- flattening and
 * tier-mapping are the caller's job, `jdStringsForThemes` in
 * operations-wiring.ts). A theme activates when ANY of its `matchTerms`
 * `experienceTermMatch`-es ANY jd string. Sorted by `scoreTheme`, descending;
 * ties keep `OPERATIONS_THEMES` order (stable sort over an already-ordered
 * list). Capped at `MAX_ACTIVATED_THEMES` -- the projects agent has no use
 * for a longer angle set in one run.
 */
export function activateThemes(jdStrings: readonly TieredJdString[]): OperationsTheme[] {
	const scored = OPERATIONS_THEMES
		.map((theme) => ({ theme, score: scoreTheme(theme, jdStrings) }))
		.filter((scored) => scored.score > 0);

	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, MAX_ACTIVATED_THEMES).map((scored) => scored.theme);
}
