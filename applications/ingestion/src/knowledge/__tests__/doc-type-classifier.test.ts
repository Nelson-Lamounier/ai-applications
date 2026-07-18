/**
 * @format
 * doc-type-classifier Unit Tests
 *
 * Pure, deterministic classification of `docs`-lane files into a closed
 * taxonomy. First-match-wins across three tiers: filename, path segment,
 * then a narrow content sniff (only reached when both path tiers miss).
 * Every content sniff carries a near-miss test to guard against false
 * positives — see file-classifier.test.ts for the sibling convention.
 */

import { classifyDocType, DOC_TYPES } from '../doc-type-classifier';

describe('DOC_TYPES', () => {
    it('is the closed 10-value taxonomy', () => {
        expect(DOC_TYPES).toEqual([
            'readme', 'adr', 'runbook', 'troubleshooting', 'concept',
            'guide', 'spec', 'changelog', 'contributing', 'doc',
        ]);
    });
});

describe('classifyDocType', () => {
    // =========================================================================
    // Tier 1 — filename (basename, case-insensitive)
    // =========================================================================
    describe('filename rules', () => {
        it('classifies README variants', () => {
            expect(classifyDocType('README.md', '')).toBe('readme');
            expect(classifyDocType('readme.md', '')).toBe('readme');
            expect(classifyDocType('packages/api/README.md', '')).toBe('readme');
        });

        it('classifies CHANGELOG variants', () => {
            expect(classifyDocType('CHANGELOG.md', '')).toBe('changelog');
            expect(classifyDocType('changelog.md', '')).toBe('changelog');
        });

        it('classifies CONTRIBUTING variants', () => {
            expect(classifyDocType('CONTRIBUTING.md', '')).toBe('contributing');
            expect(classifyDocType('docs/CONTRIBUTING.md', '')).toBe('contributing');
        });
    });

    // =========================================================================
    // Tier 2 — path segment (any position)
    // =========================================================================
    describe('path segment rules', () => {
        it('classifies decisions/adr/adrs as adr, by path alone', () => {
            expect(classifyDocType('docs/decisions/0001-use-postgres.md', '')).toBe('adr');
            expect(classifyDocType('docs/adr/0002-cache.md', '')).toBe('adr');
            expect(classifyDocType('docs/adrs/0003-queue.md', '')).toBe('adr');
        });

        it('classifies runbooks by path', () => {
            expect(classifyDocType('docs/runbooks/restart-pod.md', '')).toBe('runbook');
        });

        it('classifies troubleshooting by path', () => {
            expect(classifyDocType('docs/troubleshooting/flaky-test.md', '')).toBe('troubleshooting');
        });

        it('classifies concepts/patterns as concept', () => {
            expect(classifyDocType('docs/concepts/event-sourcing.md', '')).toBe('concept');
            expect(classifyDocType('docs/patterns/repository.md', '')).toBe('concept');
        });

        it('classifies guides/tutorials as guide', () => {
            expect(classifyDocType('docs/guides/getting-started.md', '')).toBe('guide');
            expect(classifyDocType('docs/tutorials/first-project.md', '')).toBe('guide');
        });

        it('classifies specs/plans/rfcs as spec', () => {
            expect(classifyDocType('specs/004-chunk-packing/plan.md', '')).toBe('spec');
            expect(classifyDocType('docs/plans/2026-07-18-doc-type.md', '')).toBe('spec');
            expect(classifyDocType('docs/rfcs/0009-retrieval.md', '')).toBe('spec');
        });

        it('filename tier beats path tier', () => {
            expect(classifyDocType('docs/decisions/README.md', '')).toBe('readme');
        });
    });

    // =========================================================================
    // Tier 3 — content sniff (ONLY when tiers 1-2 miss)
    // =========================================================================
    describe('content sniff — ADR shape', () => {
        it('classifies a numbered filename with a Status heading as adr', () => {
            const content = '# 0001 Use Postgres\n\n## Status\n\nAccepted\n';
            expect(classifyDocType('0001-use-postgres.md', content)).toBe('adr');
        });

        it('classifies a numbered filename with a Decision heading as adr', () => {
            const content = '# 0002 Cache Layer\n\n## Decision\n\nUse Redis.\n';
            expect(classifyDocType('notes/0002-cache-layer.md', content)).toBe('adr');
        });

        it('classifies a numbered filename with a Status: line as adr', () => {
            const content = '# 0003 Queue\n\nStatus: accepted\n\nBody text.\n';
            expect(classifyDocType('notes/0003-queue.md', content)).toBe('adr');
        });

        it('near-miss: numbered filename WITHOUT status/decision heading stays doc', () => {
            const content = '# Migration 0004\n\nSome unrelated prose about a schema change.\n';
            expect(classifyDocType('0004-add-index.md', content)).toBe('doc');
        });

        it('near-miss: Status heading WITHOUT a numbered filename stays doc', () => {
            const content = '## Status\n\nAccepted\n';
            expect(classifyDocType('notes/design-notes.md', content)).toBe('doc');
        });
    });

    describe('content sniff — runbook shape', () => {
        it('classifies Symptom + Fix headings as runbook', () => {
            const content = '## Symptom\n\nPod crash-loops.\n\n## Fix\n\nRestart it.\n';
            expect(classifyDocType('notes/pod-crash.md', content)).toBe('runbook');
        });

        it('classifies Diagnose + Verify headings as runbook', () => {
            const content = '## Diagnose\n\nCheck logs.\n\n## Verify\n\nConfirm healthy.\n';
            expect(classifyDocType('notes/investigate.md', content)).toBe('runbook');
        });

        it('near-miss: prose mentioning "runbook" without the heading pair stays doc', () => {
            const content = 'This document is a runbook for restarting the service '
                + 'when it fails to boot. See the fix below.';
            expect(classifyDocType('notes/service-notes.md', content)).toBe('doc');
        });

        it('near-miss: Symptom heading alone (no Fix/Verify) stays doc', () => {
            const content = '## Symptom\n\nPod crash-loops.\n\nInvestigation is ongoing.\n';
            expect(classifyDocType('notes/pod-crash-2.md', content)).toBe('doc');
        });
    });

    // =========================================================================
    // Tier 4 — fallback
    // =========================================================================
    describe('fallback', () => {
        it('falls back to doc when nothing matches', () => {
            expect(classifyDocType('notes/random-thoughts.md', 'Just some prose.')).toBe('doc');
        });

        it('does not content-sniff when a path rule already matched', () => {
            // /guides/ wins even though content looks ADR-shaped — content sniff
            // only runs when tiers 1-2 miss.
            const content = '## Status\n\nAccepted\n';
            expect(classifyDocType('docs/guides/0001-onboarding.md', content)).toBe('guide');
        });
    });
});
