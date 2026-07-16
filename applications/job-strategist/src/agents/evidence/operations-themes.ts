/**
 * @format
 * Operations-angle theme ontology -- the deterministic bridge from JD text to
 * retrieval queries for the projects agent. A hand-curated, FIXED set (no LLM
 * theme derivation): each theme names a way a system is OPERATED (database
 * administration, backup/recovery, cluster orchestration, ...) rather than
 * what was built with it, closing the gap operations-flavoured JDs (e.g. a
 * MongoDB TSE role) expose in the case-study-angled projects pool.
 *
 * `activateThemes` is the sole entry point: it takes the JD's flattened
 * requirement/preferred/concept strings and returns the themes whose
 * `matchTerms` are demonstrated in that vocabulary, via the SHARED
 * `experienceTermMatch` predicate (no new matching logic here). Zero
 * activations is the expected, common case -- the caller must treat that as
 * a complete no-op, fail-closed to today's behaviour.
 */
import { experienceTermMatch } from '../../ats/gate/experience-coverage.js';

export interface OperationsTheme {
	readonly key: string;
	readonly label: string;
	readonly queryTerms: string;
	readonly matchTerms: readonly string[];
	readonly kinds: readonly string[];
}

const MAX_ACTIVATED_THEMES = 3;

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

/** Number of distinct `jdStrings` entries that demonstrate at least one of
 *  `theme.matchTerms` -- a theme's activation weight. */
function countDistinctHits(theme: OperationsTheme, jdStrings: readonly string[]): number {
	return jdStrings.filter((jdString) =>
		theme.matchTerms.some((matchTerm) => experienceTermMatch(matchTerm, jdString)),
	).length;
}

/**
 * `jdStrings` = the caller's flattened `hardRequirements[].skill` + preferred
 * + concepts from `JdSignal` (kept pure here -- flattening is the caller's
 * job). A theme activates when ANY of its `matchTerms` `experienceTermMatch`
 * -es ANY jd string. Sorted by number of distinct jd strings hit, descending;
 * ties keep `OPERATIONS_THEMES` order (stable sort over an already-ordered
 * list). Capped at 3 -- the projects agent has no use for a longer angle set
 * in one run.
 */
export function activateThemes(jdStrings: readonly string[]): OperationsTheme[] {
	const scored = OPERATIONS_THEMES
		.map((theme) => ({ theme, hits: countDistinctHits(theme, jdStrings) }))
		.filter((scored) => scored.hits > 0);

	scored.sort((a, b) => b.hits - a.hits);

	return scored.slice(0, MAX_ACTIVATED_THEMES).map((scored) => scored.theme);
}
