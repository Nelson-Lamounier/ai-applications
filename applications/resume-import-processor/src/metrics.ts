/**
 * @format
 * Centralised prom-client metrics for the resume-import pipeline.
 *
 * Why a separate module:
 *  - Counters/Histograms are needed in multiple files (run-import.ts,
 *    parsers/pdf.ts, bedrock/enrich-role.ts). Defining them at the
 *    top-level of run-import.ts means imported modules can't reach them.
 *  - Lazy accessors resolve the bootstrap registry from globalThis at
 *    first call site, so modules that import this file before
 *    bootstrapK8sObservability() runs don't crash. If the bootstrap is
 *    absent (unit tests), counters register against a throwaway registry
 *    and exposition is a no-op — incrementing them is still safe.
 */
import type { Registry} from 'prom-client';
import { Counter, Histogram, register as defaultRegister } from 'prom-client';

type ObsHandleGlobal = { __obsHandle?: { registry: Registry } };

function resolveRegistry(): Registry {
  const handle = (globalThis as ObsHandleGlobal).__obsHandle;
  // Falls back to prom-client's default registry — sufficient for tests and
  // for any process that imports metrics before bootstrap completes.
  return handle?.registry ?? defaultRegister;
}

// One-time creator helpers — guarantees we only construct each metric once
// even when modules are reloaded under jest's worker isolation.
function makeCounter<L extends string>(opts: {
  name: string; help: string; labelNames?: readonly L[];
}): Counter<L> {
  return new Counter<L>({ ...opts, registers: [resolveRegistry()] });
}

function makeHistogram<L extends string>(opts: {
  name: string; help: string; labelNames?: readonly L[]; buckets: number[];
}): Histogram<L> {
  return new Histogram<L>({ ...opts, registers: [resolveRegistry()] });
}

let _textractFallback:    Counter<'reason'> | undefined;
let _textractDuration:    Histogram<never> | undefined;
let _tavilyDuration:      Histogram<'outcome'> | undefined;
let _tavilyCache:         Counter<'result'> | undefined;
let _fanoutTotal:         Counter<'outcome'> | undefined;
let _bedrockDuration:     Histogram<'purpose'> | undefined;
let _embedDuration:       Histogram<never> | undefined;
let _persistDuration:     Histogram<'op'> | undefined;
let _embeddingsCreated:   Counter<never> | undefined;
let _freeTierCapped:      Counter<never> | undefined;
let _careerEntries:       Counter<'type'> | undefined;

export const textractFallbackTotal = (): Counter<'reason'> =>
  _textractFallback ??= makeCounter({
    name: 'resume_import_textract_fallback_total',
    help: 'Number of imports that fell through pdf-parse to Textract OCR, by reason.',
    labelNames: ['reason'] as const,
  });

export const textractDurationSeconds = (): Histogram<never> =>
  _textractDuration ??= makeHistogram({
    name: 'resume_import_textract_duration_seconds',
    help: 'AWS Textract round-trip duration (StartDocumentTextDetection → result).',
    buckets: [1, 5, 10, 20, 30, 45, 60, 90, 120, 180],
  });

export const tavilyDurationSeconds = (): Histogram<'outcome'> =>
  _tavilyDuration ??= makeHistogram({
    name: 'resume_import_tavily_duration_seconds',
    help: 'Tavily web-search call duration, labelled by outcome.',
    labelNames: ['outcome'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30],
  });

export const tavilyCacheTotal = (): Counter<'result'> =>
  _tavilyCache ??= makeCounter({
    name: 'resume_import_tavily_cache_total',
    help: 'Tavily cache lookups by result (hit|miss).',
    labelNames: ['result'] as const,
  });

export const fanoutTotal = (): Counter<'outcome'> =>
  _fanoutTotal ??= makeCounter({
    name: 'resume_import_fanout_total',
    help: 'Tavily fan-out role outcomes (ok|empty|failed|skipped_budget).',
    labelNames: ['outcome'] as const,
  });

export const bedrockDurationSeconds = (): Histogram<'purpose'> =>
  _bedrockDuration ??= makeHistogram({
    name: 'resume_import_bedrock_duration_seconds',
    help: 'Bedrock InvokeModel duration by purpose (extract|enrich).',
    labelNames: ['purpose'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  });

export const embedDurationSeconds = (): Histogram<never> =>
  _embedDuration ??= makeHistogram({
    name: 'resume_import_embed_duration_seconds',
    help: 'Per-entry embedding generation duration.',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20],
  });

export const persistDurationSeconds = (): Histogram<'op'> =>
  _persistDuration ??= makeHistogram({
    name: 'resume_import_persist_duration_seconds',
    help: 'Postgres write duration by operation (insert_career|update_status|insert_embedding).',
    labelNames: ['op'] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });

export const embeddingsCreatedTotal = (): Counter<never> =>
  _embeddingsCreated ??= makeCounter({
    name: 'resume_import_embeddings_created_total',
    help: 'Total embedding rows created across all imports.',
  });

export const freeTierCappedTotal = (): Counter<never> =>
  _freeTierCapped ??= makeCounter({
    name: 'resume_import_free_tier_capped_total',
    help: 'Times an entry was skipped due to FREE_TIER_ENRICHMENT_CAP.',
  });

export const careerEntriesTotal = (): Counter<'type'> =>
  _careerEntries ??= makeCounter({
    name: 'resume_import_career_entries_total',
    help: 'Career entries extracted by Bedrock, labelled by entry type.',
    labelNames: ['type'] as const,
  });

/**
 * Seed zero-valued series for each known label set so Grafana renders "0"
 * instead of "No data" before the first observation lands.
 */
export function seedZeroSeries(): void {
  for (const reason of ['threw', 'empty', 'short_text'] as const) {
    textractFallbackTotal().inc({ reason }, 0);
  }
  textractDurationSeconds().observe(0);
  for (const outcome of ['success', 'empty', 'failed'] as const) {
    tavilyDurationSeconds().observe({ outcome }, 0);
  }
  for (const result of ['hit', 'miss'] as const) {
    tavilyCacheTotal().inc({ result }, 0);
  }
  for (const outcome of ['ok', 'empty', 'failed', 'skipped_budget'] as const) {
    fanoutTotal().inc({ outcome }, 0);
  }
  for (const purpose of ['extract', 'enrich', 'gap_analysis'] as const) {
    bedrockDurationSeconds().observe({ purpose }, 0);
  }
  embedDurationSeconds().observe(0);
  for (const op of ['insert_career', 'update_status', 'insert_embedding'] as const) {
    persistDurationSeconds().observe({ op }, 0);
  }
  embeddingsCreatedTotal().inc(0);
  freeTierCappedTotal().inc(0);
  for (const type of ['experience', 'education'] as const) {
    careerEntriesTotal().inc({ type }, 0);
  }
}
