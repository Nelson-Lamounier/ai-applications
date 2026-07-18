/** @format */
import { formatConceptEvidenceContext, type RepoConceptRow } from '../concept-evidence-context.js';

const observabilityRow = (repoFullName: string, detector: string, files: number): RepoConceptRow => ({
    canonicalName: 'observability',
    repoFullName,
    detector,
    files,
});

const aliasMap = new Map<string, string>([
    ['observability', 'observability'],
    ['monitoring', 'observability'],
    ['distributed systems', 'distributed systems'],
    ['ci-cd', 'ci/cd pipelines'],
    ['ci/cd pipelines', 'ci/cd pipelines'],
]);

describe('formatConceptEvidenceContext', () => {
    it('returns a non-empty context block for a JD concept with evidence', () => {
        const result = formatConceptEvidenceContext(
            ['observability'],
            [observabilityRow('org/repo-a', 'grafana-config', 11)],
            aliasMap,
        );
        expect(result).toContain('## Evidenced Concepts');
        expect(result).toContain('- observability: 11 files across 1 repos (detectors: grafana-config)');
    });

    it('returns "" when no JD concept intersects any evidence', () => {
        const result = formatConceptEvidenceContext(
            ['ci-cd'],
            [observabilityRow('org/repo-a', 'grafana-config', 11)],
            aliasMap,
        );
        expect(result).toBe('');
    });

    it('returns "" for empty jdConcepts', () => {
        expect(formatConceptEvidenceContext([], [observabilityRow('org/repo-a', 'grafana-config', 11)], aliasMap)).toBe('');
    });

    it('returns "" for empty repoConcepts', () => {
        expect(formatConceptEvidenceContext(['observability'], [], aliasMap)).toBe('');
    });

    it('aggregates file counts and repo counts across multiple rows for the same canonical', () => {
        const result = formatConceptEvidenceContext(
            ['observability'],
            [
                observabilityRow('org/repo-a', 'grafana-config', 11),
                observabilityRow('org/repo-b', 'grafana-config', 4),
            ],
            aliasMap,
        );
        expect(result).toContain('- observability: 15 files across 2 repos (detectors: grafana-config)');
    });

    it('dedupes detector names within one canonical, sorted', () => {
        const result = formatConceptEvidenceContext(
            ['observability'],
            [
                observabilityRow('org/repo-a', 'grafana-config', 5),
                observabilityRow('org/repo-a', 'prometheus-config', 3),
                observabilityRow('org/repo-b', 'grafana-config', 2),
            ],
            aliasMap,
        );
        expect(result).toContain('detectors: grafana-config, prometheus-config');
        // Deduped, not repeated for the second grafana-config row.
        const detectorMatches = result.match(/grafana-config/g) ?? [];
        expect(detectorMatches).toHaveLength(1);
    });

    it('canonicalises JD mentions via the alias map (case-insensitive, trimmed)', () => {
        const result = formatConceptEvidenceContext(
            ['  Monitoring  '],
            [observabilityRow('org/repo-a', 'grafana-config', 11)],
            aliasMap,
        );
        expect(result).toContain('- observability:');
    });

    it('includes only the concepts the JD mentions — not every evidenced concept', () => {
        const distributedSystemsRow: RepoConceptRow = {
            canonicalName: 'distributed systems',
            repoFullName:  'org/repo-a',
            detector:      'broker-topology',
            files:         3,
        };
        const result = formatConceptEvidenceContext(
            ['observability'],
            [observabilityRow('org/repo-a', 'grafana-config', 11), distributedSystemsRow],
            aliasMap,
        );
        expect(result).toContain('observability');
        expect(result).not.toContain('distributed systems');
    });

    it('header is present once regardless of number of matching concepts', () => {
        const distributedSystemsRow: RepoConceptRow = {
            canonicalName: 'distributed systems',
            repoFullName:  'org/repo-a',
            detector:      'broker-topology',
            files:         3,
        };
        const result = formatConceptEvidenceContext(
            ['observability', 'distributed systems'],
            [observabilityRow('org/repo-a', 'grafana-config', 11), distributedSystemsRow],
            aliasMap,
        );
        const headerCount = (result.match(/## Evidenced Concepts/g) ?? []).length;
        expect(headerCount).toBe(1);
        expect(result).toContain('observability');
        expect(result).toContain('distributed systems');
    });

    it('a JD concept with no alias entry falls back to its own lowercased/trimmed form', () => {
        const row: RepoConceptRow = {
            canonicalName: 'process automation',
            repoFullName:  'org/repo-a',
            detector:      'workflow-ci',
            files:         2,
        };
        const result = formatConceptEvidenceContext(['Process Automation'], [row], new Map());
        expect(result).toContain('- process automation:');
    });
});
