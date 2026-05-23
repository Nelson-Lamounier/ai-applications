/**
 * @format
 * Metric CONTRACT test for the "Resume Import — Upload to Career Entries"
 * dashboard.
 *
 * The dashboard's sub-stage and drill-down panels query a fixed set of
 * resume_import_* series by name + label. This test pins that contract against
 * metrics.ts: if a metric is renamed, a label is dropped, or a purpose/op the
 * dashboard splits on disappears, CI fails here instead of the panel silently
 * rendering "No data".
 *
 * Scope: the sub-step metrics defined in metrics.ts. The Job-terminal metrics
 * (resume_import_runs_total, *_duration_seconds, *_step_duration_seconds) live
 * in run-import.ts / run-enrichment.ts, whose modules self-execute main() on
 * import and so can't be unit-imported — those are covered by the synthetic
 * end-to-end check (Layer 3), not here.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { register } from 'prom-client';
import { seedZeroSeries } from '../metrics.js';

// The contract the dashboard depends on: metric name -> required label keys.
// Mirrors the queries in
// kubernetes-bootstrap/charts/monitoring/chart/dashboards/resume-import.json
const CONTRACT: Record<string, string[]> = {
  resume_import_textract_fallback_total:  ['reason'],
  resume_import_textract_duration_seconds: [],
  resume_import_tavily_duration_seconds:  ['outcome'],
  resume_import_tavily_cache_total:       ['result'],
  resume_import_fanout_total:             ['outcome'],
  resume_import_bedrock_duration_seconds: ['purpose'],
  resume_import_embed_duration_seconds:   [],
  resume_import_persist_duration_seconds: ['op'],
  resume_import_embeddings_created_total: [],
  resume_import_free_tier_capped_total:   [],
  resume_import_career_entries_total:     ['type'],
};

type JsonMetric = { name: string; values: { labels: Record<string, string> }[] };

let byName: Map<string, JsonMetric>;

beforeAll(async () => {
  seedZeroSeries(); // registers every series with its label set at value 0
  const metrics = (await register.getMetricsAsJSON()) as unknown as JsonMetric[];
  byName = new Map(metrics.map((m) => [m.name, m]));
});

describe('resume_import_* metric contract (resume-import dashboard)', () => {
  it.each(Object.entries(CONTRACT))('exposes %s with the required labels', (name, labels) => {
    const metric = byName.get(name);
    expect(metric).toBeDefined(); // metric must be registered under this exact name

    const seen = new Set<string>();
    for (const v of metric!.values) {
      for (const k of Object.keys(v.labels)) if (k !== 'le') seen.add(k);
    }
    // every required label key must be present
    expect([...seen]).toEqual(expect.arrayContaining(labels));
  });

  it('seeds the label values the dashboard splits panels on', () => {
    const labelValues = (name: string, key: string): Set<string> => {
      const s = new Set<string>();
      for (const v of byName.get(name)?.values ?? []) {
        const val = v.labels[key];
        if (val !== undefined) s.add(val);
      }
      return s;
    };
    // Bedrock "by purpose" panels — gap_analysis must exist (it had no panel
    // before and was invisible; the dashboard now plots it).
    expect(labelValues('resume_import_bedrock_duration_seconds', 'purpose'))
      .toEqual(new Set(['extract', 'enrich', 'gap_analysis']));
    // Persist "by op" panel
    expect(labelValues('resume_import_persist_duration_seconds', 'op'))
      .toEqual(new Set(['insert_career', 'update_status', 'insert_embedding']));
    // career-entries "by type"
    expect(labelValues('resume_import_career_entries_total', 'type'))
      .toEqual(new Set(['experience', 'education']));
  });
});
