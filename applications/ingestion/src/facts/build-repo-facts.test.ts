/** @format */
import { describe, it, expect } from '@jest/globals';
import type { RepoRoleSignals } from '@bedrock/shared';

import { assembleRepoFacts } from './build-repo-facts.js';
import type { ConceptDetectorRow, RepoFactsInputs, TechEvidenceRow } from './build-repo-facts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function techRow(over: Partial<TechEvidenceRow> = {}): TechEvidenceRow {
    return {
        name:          'example',
        category:      'language',
        version:       null,
        evidenceCount: 1,
        ...over,
    };
}

function signals(over: Partial<RepoRoleSignals> = {}): RepoRoleSignals {
    return {
        primaryLanguage: null,
        techStack:       [],
        topics:          [],
        archetype:       {},
        evidence:        {},
        fileClassCounts: {},
        ...over,
    };
}

function inputs(over: Partial<RepoFactsInputs> = {}): RepoFactsInputs {
    return {
        techRows:            [],
        primaryLanguage:     null,
        signals:             signals(),
        hasMonitoringConfig: false,
        conceptRows:         [],
        ...over,
    };
}

function conceptRow(over: Partial<ConceptDetectorRow> = {}): ConceptDetectorRow {
    return {
        name:     'observability',
        detector: 'monitoring-config',
        files:    3,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// (a) Category -> lane mapping
// ---------------------------------------------------------------------------

describe('assembleRepoFacts — category -> lane mapping', () => {
    it('routes one representative category per lane, plus the judged placements', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'typescript', category: 'language' }),
            techRow({ name: 'react',      category: 'framework_web' }),
            techRow({ name: 'postgresql', category: 'database_relational' }),
            techRow({ name: 'terraform',  category: 'iac' }),
            techRow({ name: 'jest',       category: 'testing' }),
            // Judged cases documented in the module header.
            techRow({ name: 'kafka',      category: 'message_broker' }), // -> infrastructure
            techRow({ name: 'nodejs',     category: 'runtime' }),        // -> tools
            techRow({ name: 'bedrock',    category: 'ai_platform' }),    // -> tools
        ];

        const facts = assembleRepoFacts(inputs({ techRows }));

        expect(facts.languages.map((e) => e.name)).toEqual(['typescript']);
        expect(facts.frameworks.map((e) => e.name)).toEqual(['react']);
        expect(facts.databases.map((e) => e.name)).toEqual(['postgresql']);
        expect(facts.infrastructure.map((e) => e.name).sort()).toEqual(['kafka', 'terraform']);
        expect(facts.tools.map((e) => e.name).sort()).toEqual(['bedrock', 'jest', 'nodejs']);
    });

    it('falls through an unrecognised category to tools rather than dropping it', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'mystery-tech', category: 'some_future_category' }),
        ];

        const facts = assembleRepoFacts(inputs({ techRows }));

        expect(facts.tools.map((e) => e.name)).toEqual(['mystery-tech']);
        expect(facts.languages).toHaveLength(0);
        expect(facts.frameworks).toHaveLength(0);
        expect(facts.databases).toHaveLength(0);
        expect(facts.infrastructure).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// (b) Version: first non-null wins
// ---------------------------------------------------------------------------

describe('assembleRepoFacts — version first-non-null-wins', () => {
    it('keeps the first non-null version when a later duplicate row also has one', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'nodejs', category: 'runtime', version: '18.0.0', evidenceCount: 1 }),
            techRow({ name: 'nodejs', category: 'runtime', version: '20.0.0', evidenceCount: 1 }),
        ];

        const facts = assembleRepoFacts(inputs({ techRows }));

        expect(facts.tools).toEqual([{ name: 'nodejs', version: '18.0.0', evidenceCount: 2 }]);
    });

    it('backfills from a later row when the first row has a null version', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'nodejs', category: 'runtime', version: null, evidenceCount: 1 }),
            techRow({ name: 'nodejs', category: 'runtime', version: '20.0.0', evidenceCount: 1 }),
        ];

        const facts = assembleRepoFacts(inputs({ techRows }));

        expect(facts.tools).toEqual([{ name: 'nodejs', version: '20.0.0', evidenceCount: 2 }]);
    });

    it('stays null when no row in the group carries a version', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'react', category: 'framework_web', version: null }),
        ];

        const facts = assembleRepoFacts(inputs({ techRows }));

        expect(facts.frameworks[0]?.version).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (c) Concepts from signals, including the none-fire case
// ---------------------------------------------------------------------------

describe('assembleRepoFacts — signal-derived concepts', () => {
    it('emits no concepts when no signal fires', () => {
        const facts = assembleRepoFacts(inputs());
        expect(facts.concepts).toEqual([]);
    });

    it('fires "ci/cd pipelines" from has_ci', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_ci: true } }),
        }));
        expect(facts.concepts).toContainEqual({ name: 'ci/cd pipelines', detector: 'signal', files: 0 });
    });

    it('fires "container orchestration" from has_k8s_manifests OR has_helm_chart OR has_argocd_apps', () => {
        const viaK8s = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_k8s_manifests: true } }),
        }));
        expect(viaK8s.concepts).toContainEqual({ name: 'container orchestration', detector: 'signal', files: 0 });

        const viaHelm = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_helm_chart: true } }),
        }));
        expect(viaHelm.concepts).toContainEqual({ name: 'container orchestration', detector: 'signal', files: 0 });

        const viaArgo = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_argocd_apps: true } }),
        }));
        expect(viaArgo.concepts).toContainEqual({ name: 'container orchestration', detector: 'signal', files: 0 });
    });

    it('fires "infrastructure as code" from has_iac', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_iac: true } }),
        }));
        expect(facts.concepts).toContainEqual({ name: 'infrastructure as code', detector: 'signal', files: 0 });
    });

    it('fires "observability" from the separately-threaded hasMonitoringConfig flag', () => {
        const facts = assembleRepoFacts(inputs({ hasMonitoringConfig: true }));
        expect(facts.concepts).toContainEqual({ name: 'observability', detector: 'signal', files: 0 });
    });

    it('fires "database migrations" from evidence.has_migrations', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({ evidence: { has_migrations: true } }),
        }));
        expect(facts.concepts).toContainEqual({ name: 'database migrations', detector: 'signal', files: 0 });
    });

    it('fires every concept at once when every signal is true', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({
                archetype: { has_ci: true, has_k8s_manifests: true, has_iac: true },
                evidence:  { has_migrations: true },
            }),
            hasMonitoringConfig: true,
        }));
        expect(facts.concepts.map((c) => c.name).sort()).toEqual([
            'ci/cd pipelines',
            'container orchestration',
            'database migrations',
            'infrastructure as code',
            'observability',
        ].sort());
    });
});

// ---------------------------------------------------------------------------
// (c2) Detector-backed concept rows vs. signal-derived fallback
// ---------------------------------------------------------------------------

describe('assembleRepoFacts — detector-backed concepts vs. signal fallback', () => {
    it('detector rows win: a concept with a detector row does not also get a signal fallback entry', () => {
        const facts = assembleRepoFacts(inputs({
            hasMonitoringConfig: true,
            conceptRows: [conceptRow({ name: 'observability', detector: 'monitoring-config', files: 4 })],
        }));

        expect(facts.concepts).toEqual([
            { name: 'observability', detector: 'monitoring-config', files: 4 },
        ]);
    });

    it('signal fallback fills gaps: a concept with zero detector rows still gets its signal entry', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_iac: true } }),
            conceptRows: [conceptRow({ name: 'observability', detector: 'monitoring-config', files: 2 })],
        }));

        expect(facts.concepts).toContainEqual({ name: 'observability', detector: 'monitoring-config', files: 2 });
        expect(facts.concepts).toContainEqual({ name: 'infrastructure as code', detector: 'signal', files: 0 });
    });

    it('multiple detectors for one concept each become their own entry', () => {
        const facts = assembleRepoFacts(inputs({
            conceptRows: [
                conceptRow({ name: 'ci/cd pipelines', detector: 'workflow-ci', files: 3 }),
                conceptRow({ name: 'ci/cd pipelines', detector: 'workflow-deploy', files: 1 }),
            ],
        }));

        expect(facts.concepts).toEqual([
            { name: 'ci/cd pipelines', detector: 'workflow-ci', files: 3 },
            { name: 'ci/cd pipelines', detector: 'workflow-deploy', files: 1 },
        ]);
    });

    it('both-present case: detector rows for one concept and signal fallback for a different concept coexist', () => {
        const facts = assembleRepoFacts(inputs({
            signals: signals({ archetype: { has_ci: true, has_iac: true } }),
            conceptRows: [conceptRow({ name: 'container orchestration', detector: 'k8s-orchestration', files: 5 })],
        }));

        expect(facts.concepts).toContainEqual({ name: 'container orchestration', detector: 'k8s-orchestration', files: 5 });
        // has_ci and has_iac fired but neither has a detector row in this
        // repo's conceptRows, so both fall back to their signal entry —
        // 'ci/cd pipelines' now matches the detector canonical exactly (see
        // the module header note), it just has no detector row here.
        expect(facts.concepts).toContainEqual({ name: 'ci/cd pipelines', detector: 'signal', files: 0 });
        expect(facts.concepts).toContainEqual({ name: 'infrastructure as code', detector: 'signal', files: 0 });
        // container orchestration's signal condition never fired here, so there is
        // exactly one 'container orchestration' entry (the detector-backed one).
        expect(facts.concepts.filter((c) => c.name === 'container orchestration')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Primary language fold-in
// ---------------------------------------------------------------------------

describe('assembleRepoFacts — primary language fold-in', () => {
    it('adds primary_language to languages when no matching tech-evidence row exists', () => {
        const facts = assembleRepoFacts(inputs({ primaryLanguage: 'Go' }));
        expect(facts.languages).toEqual([{ name: 'go', version: null, evidenceCount: 0 }]);
    });

    it('does not duplicate primary_language when a language row already covers it (case-insensitive)', () => {
        const techRows: TechEvidenceRow[] = [
            techRow({ name: 'go', category: 'language', version: '1.22', evidenceCount: 5 }),
        ];
        const facts = assembleRepoFacts(inputs({ techRows, primaryLanguage: 'Go' }));
        expect(facts.languages).toEqual([{ name: 'go', version: '1.22', evidenceCount: 5 }]);
    });

    it('leaves languages empty when primary_language is null and no rows exist', () => {
        const facts = assembleRepoFacts(inputs({ primaryLanguage: null }));
        expect(facts.languages).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// (d) Role passthrough is exercised at the buildRepoFacts orchestration
// layer (classifyComponentKind is a shared, independently-tested pure
// function) — see build-repo-facts.build.test.ts / RepoFactsRepository.test.ts
// for the persisted-row assertion that `role` lands unchanged on the row.
// ---------------------------------------------------------------------------
