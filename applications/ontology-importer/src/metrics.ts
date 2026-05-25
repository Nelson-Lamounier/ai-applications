/** @format */
import { Counter, Gauge, Histogram } from 'prom-client';
import type { Registry } from 'prom-client';

/**
 * Ontology-importer Prometheus metrics, registered against the bootstrap
 * registry from `bootstrapK8sObservability` so they are pushed to Pushgateway
 * on Job exit (mirrors tech-extractor's inline metric construction).
 */
export interface OntologyImportMetrics {
    importDuration:     Histogram<'source'>;
    importEntries:      Counter<'source' | 'outcome'>;
    reviewQueueDepth:   Gauge<string>;
    resolutionRate:     Gauge<'ecosystem'>;
}

export function buildMetrics(registry: Registry): OntologyImportMetrics {
    return {
        importDuration: new Histogram({
            name: 'ontology_import_duration_seconds',
            help: 'Wall-clock duration of a per-source ontology import.',
            labelNames: ['source'] as const,
            registers: [registry],
        }),
        importEntries: new Counter({
            name: 'ontology_import_entries_total',
            help: 'Ontology import entries by source and outcome.',
            labelNames: ['source', 'outcome'] as const,
            registers: [registry],
        }),
        reviewQueueDepth: new Gauge({
            name: 'ontology_import_review_queue_depth',
            help: 'Current depth of the ontology review queue.',
            registers: [registry],
        }),
        resolutionRate: new Gauge({
            name: 'ontology_import_resolution_rate',
            help: 'Fraction of fetched entries resolved deterministically, by ecosystem.',
            labelNames: ['ecosystem'] as const,
            registers: [registry],
        }),
    };
}
