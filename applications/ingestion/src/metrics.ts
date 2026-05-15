/**
 * @format
 * Sub-stage Prometheus metrics for the ingestion pipeline.
 *
 * Mirrors the layout used by resume-import-processor/src/metrics.ts:
 * lazy accessors so files imported before bootstrapK8sObservability() runs
 * still work, and seedZeroSeries() so Grafana panels read "0" instead of
 * "No data" before the first observation lands.
 */
import {
    Counter,
    Histogram,
    Registry,
    register as defaultRegister,
} from 'prom-client';

type ObsHandleGlobal = { __obsHandle?: { registry: Registry } };

function resolveRegistry(): Registry {
    return (globalThis as ObsHandleGlobal).__obsHandle?.registry ?? defaultRegister;
}

function makeHistogram<L extends string>(opts: {
    name: string; help: string; labelNames?: readonly L[]; buckets: number[];
}): Histogram<L> {
    return new Histogram<L>({ ...opts, registers: [resolveRegistry()] });
}

function makeCounter<L extends string>(opts: {
    name: string; help: string; labelNames?: readonly L[];
}): Counter<L> {
    return new Counter<L>({ ...opts, registers: [resolveRegistry()] });
}

let _profileCollectDuration: Histogram<never> | undefined;
let _profileExtractDuration: Histogram<never> | undefined;
let _profileEmbedDuration:   Histogram<never> | undefined;
let _chunkIngestDuration:    Histogram<'outcome'> | undefined;
let _kbQualityScore:         Histogram<never> | undefined;
let _profileExtractCalls:    Counter<'outcome'> | undefined;

export const profileCollectDurationSeconds = (): Histogram<never> =>
    _profileCollectDuration ??= makeHistogram({
        name:    'ingestion_profile_collect_duration_seconds',
        help:    'Time to fetch profile-input files from GitHub (README, package.json, lockfiles, etc.).',
        buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    });

export const profileExtractDurationSeconds = (): Histogram<never> =>
    _profileExtractDuration ??= makeHistogram({
        name:    'ingestion_profile_extract_duration_seconds',
        help:    'Bedrock InvokeModel duration for repository profile extraction.',
        buckets: [1, 5, 10, 20, 30, 60, 120, 300],
    });

export const profileEmbedDurationSeconds = (): Histogram<never> =>
    _profileEmbedDuration ??= makeHistogram({
        name:    'ingestion_profile_embed_duration_seconds',
        help:    'Titan embedding generation for profile chunks (one_liner + description + highlights).',
        buckets: [0.5, 1, 2, 5, 10, 30, 60],
    });

export const chunkIngestDurationSeconds = (): Histogram<'outcome'> =>
    _chunkIngestDuration ??= makeHistogram({
        name:       'ingestion_chunk_ingest_duration_seconds',
        help:       'Orchestrator.ingestRepo wall-clock — chunk + enrich + embed + persist + prune.',
        labelNames: ['outcome'] as const,
        buckets:    [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    });

export const kbQualityScoreHist = (): Histogram<never> =>
    _kbQualityScore ??= makeHistogram({
        name:    'ingestion_kb_quality_score',
        help:    'Quality score (0..1) of each ingested repository profile. Lower scores indicate sparse evidence.',
        buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    });

export const profileExtractCallsTotal = (): Counter<'outcome'> =>
    _profileExtractCalls ??= makeCounter({
        name:       'ingestion_profile_extract_calls_total',
        help:       'Profile-extraction outcomes (success / failed).',
        labelNames: ['outcome'] as const,
    });

export function seedZeroSeries(): void {
    profileCollectDurationSeconds().observe(0);
    profileExtractDurationSeconds().observe(0);
    profileEmbedDurationSeconds().observe(0);
    for (const outcome of ['success', 'failed'] as const) {
        chunkIngestDurationSeconds().observe({ outcome }, 0);
        profileExtractCallsTotal().inc({ outcome }, 0);
    }
    kbQualityScoreHist().observe(0);
}
