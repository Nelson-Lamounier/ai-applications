/** @format */
import { OPERATIONS_THEMES, activateThemes } from '../operations-themes.js';

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

describe('activateThemes', () => {
	it('activates database-operations + backup-recovery + one more for a MongoDB-TSE-shaped JD, ordered by hit count, capped at 3', () => {
		const jdStrings = [
			'production database systems',
			'MongoDB administration',
			'PostgreSQL replication',
			'backup and recovery',
			'disaster recovery planning',
			'performance tuning',
			'Kubernetes',
			'networking (DNS, TCP/IP, SSL/TLS)',
		];
		const activated = activateThemes(jdStrings);

		expect(activated).toHaveLength(3);
		expect(activated.map((t) => t.key)).toEqual([
			'database-operations',
			'backup-recovery',
			'performance-tuning',
		]);
	});

	it('activates ZERO themes for a frontend-only JD', () => {
		const jdStrings = ['React', 'CSS', 'web vitals', 'accessibility', 'responsive design'];
		expect(activateThemes(jdStrings)).toEqual([]);
	});

	it('matches through experienceTermMatch -- a single "PostgreSQL" jd string activates database-operations', () => {
		const activated = activateThemes(['PostgreSQL']);
		expect(activated.map((t) => t.key)).toEqual(['database-operations']);
	});

	it('breaks ties by ontology order when hit counts are equal', () => {
		// storage (pos 3) and security-hardening (pos 5) each hit exactly one
		// distinct jd string here -- storage must sort first (earlier in
		// OPERATIONS_THEMES) despite matchTerms being iterated independently.
		const jdStrings = ['storage volumes', 'security authentication'];
		const activated = activateThemes(jdStrings);
		expect(activated.map((t) => t.key)).toEqual(['storage', 'security-hardening']);
	});

	it('counts DISTINCT jd strings hit, not matchTerm hits -- two matchTerms landing in the same string still count once', () => {
		// "performance tuning" hits both the "performance" and "tuning"
		// matchTerms of performance-tuning, but that is only ONE distinct jd
		// string -- it must not outrank backup-recovery, which is hit by two
		// separate jd strings below.
		const jdStrings = ['performance tuning', 'backup and recovery', 'disaster recovery'];
		const activated = activateThemes(jdStrings);
		expect(activated.map((t) => t.key)).toEqual(['backup-recovery', 'performance-tuning']);
	});

	it('returns an empty array for an empty jdStrings input', () => {
		expect(activateThemes([])).toEqual([]);
	});
});
