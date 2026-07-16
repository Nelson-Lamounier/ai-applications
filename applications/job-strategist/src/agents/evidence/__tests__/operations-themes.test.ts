/** @format */
import { OPERATIONS_THEMES, activateThemes, type TieredJdString } from '../operations-themes.js';

/** All-'preferred' fixtures below don't care about tiering -- weight is
 *  uniform, so relative ranking still reduces to distinct-hit counting,
 *  preserving the pre-tiering semantics those tests assert on. */
function preferred(text: string): TieredJdString {
	return { text, tier: 'preferred' };
}

function required(text: string): TieredJdString {
	return { text, tier: 'required' };
}

describe('OPERATIONS_THEMES', () => {
	it('has exactly the seven ontology entries, keys in spec order', () => {
		expect(OPERATIONS_THEMES.map((t) => t.key)).toEqual([
			'database-operations',
			'performance-tuning',
			'storage',
			'networking-protocols',
			'security-hardening',
			'backup-recovery',
			'cluster-orchestration',
		]);
	});

	it('database-operations matches the spec verbatim', () => {
		const theme = OPERATIONS_THEMES.find((t) => t.key === 'database-operations');
		expect(theme).toEqual({
			key: 'database-operations',
			label: 'database operations',
			queryTerms: 'database operations connection pooling migrations schema backup production',
			matchTerms: ['database', 'databases', 'rdbms', 'nosql', 'mongodb', 'postgresql', 'sql'],
			kinds: ['backend', 'infra'],
		});
	});

	it('cluster-orchestration matches the spec verbatim', () => {
		const theme = OPERATIONS_THEMES.find((t) => t.key === 'cluster-orchestration');
		expect(theme).toEqual({
			key: 'cluster-orchestration',
			label: 'cluster orchestration',
			queryTerms: 'kubernetes cluster orchestration autoscaling operators nodes',
			matchTerms: ['kubernetes', 'cluster', 'clusters', 'orchestration', 'operators'],
			kinds: ['infra'],
		});
	});
});

describe('activateThemes -- tier-weighted scoring', () => {
	it('a required box (networking-protocols) activates within the cap-4 top set alongside a disqualifying + required-heavy JD, ordered by weighted score', () => {
		// Regression fixture for live run fe421faf: under the OLD raw-hit-count
		// ranking + cap 3, networking-protocols (a single required-tier hit)
		// lost the top-3 cut to themes accumulated purely from preferred-tier
		// concept strings. Tier weighting (disqualifying=3, required=2,
		// preferred=1) plus cap 4 must let it through.
		const jdStrings: TieredJdString[] = [
			{ text: 'MongoDB administration', tier: 'disqualifying' }, // -> database-operations
			{ text: 'backup and recovery', tier: 'required' },         // -> backup-recovery
			{ text: 'networking (DNS, TCP/IP, SSL/TLS)', tier: 'required' }, // -> networking-protocols
			{ text: 'PostgreSQL replication', tier: 'preferred' },     // -> database-operations (2nd hit)
			{ text: 'disaster recovery planning', tier: 'preferred' }, // -> backup-recovery (2nd hit)
			{ text: 'performance tuning', tier: 'preferred' },         // -> performance-tuning
			{ text: 'Kubernetes', tier: 'preferred' },                 // -> cluster-orchestration
		];

		const activated = activateThemes(jdStrings);

		expect(activated).toHaveLength(4);
		expect(activated.map((t) => t.key)).toEqual([
			'database-operations', // disqualifying(3) + preferred(1) = 4
			'backup-recovery',     // required(2) + preferred(1) = 3
			'networking-protocols', // required(2) = 2
			'performance-tuning',  // preferred(1); ties cluster-orchestration(1), wins ontology-order tie-break
		]);
	});

	it('a higher tier wins a tied raw-hit-count against an earlier-ontology-order preferred theme', () => {
		// storage (idx 2) and networking-protocols (idx 3) each get exactly one
		// distinct hit. Under raw-count-only ranking the ontology-order
		// tie-break would put storage first regardless of tier; tier weighting
		// must put the required-tier hit ahead instead.
		const jdStrings: TieredJdString[] = [preferred('storage volumes'), required('networking protocols')];
		const activated = activateThemes(jdStrings);
		expect(activated.map((t) => t.key)).toEqual(['networking-protocols', 'storage']);
	});

	it('activates ZERO themes for a frontend-only JD', () => {
		const jdStrings = ['React', 'CSS', 'web vitals', 'accessibility', 'responsive design'].map(preferred);
		expect(activateThemes(jdStrings)).toEqual([]);
	});

	it('matches through experienceTermMatch -- a single "PostgreSQL" jd string activates database-operations', () => {
		const activated = activateThemes([preferred('PostgreSQL')]);
		expect(activated.map((t) => t.key)).toEqual(['database-operations']);
	});

	it('breaks ties by ontology order when weighted scores are equal (same tier, one hit each)', () => {
		// storage (pos 3) and security-hardening (pos 5) each hit exactly one
		// distinct jd string, at the same tier -- storage must sort first
		// (earlier in OPERATIONS_THEMES).
		const jdStrings = ['storage volumes', 'security authentication'].map(preferred);
		const activated = activateThemes(jdStrings);
		expect(activated.map((t) => t.key)).toEqual(['storage', 'security-hardening']);
	});

	it('counts DISTINCT jd strings hit, not matchTerm hits -- two matchTerms landing in the same string still count once', () => {
		// "performance tuning" hits both the "performance" and "tuning"
		// matchTerms of performance-tuning, but that is only ONE distinct jd
		// string -- it must not outrank backup-recovery, which is hit by two
		// separate jd strings below (same tier throughout, so this isolates
		// distinct-counting from tier weighting).
		const jdStrings = ['performance tuning', 'backup and recovery', 'disaster recovery'].map(required);
		const activated = activateThemes(jdStrings);
		expect(activated.map((t) => t.key)).toEqual(['backup-recovery', 'performance-tuning']);
	});

	it('returns an empty array for an empty jdStrings input', () => {
		expect(activateThemes([])).toEqual([]);
	});
});
