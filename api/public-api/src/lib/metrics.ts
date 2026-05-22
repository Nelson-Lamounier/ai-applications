/**
 * @file metrics.ts
 * @description Prometheus registry for public-api. Mirrors admin-api's
 * low-cardinality counter conventions. Scraped at GET /metrics by the
 * cluster Prometheus (kubernetes-service-endpoints job).
 */
import { Registry, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({
  service: process.env['OTEL_SERVICE_NAME'] ?? 'public-api',
  env:     process.env['DEPLOY_ENV']         ?? 'dev',
});

collectDefaultMetrics({ register: registry });

/**
 * Read-cache outcomes. `cache` is the logical cache name (e.g.
 * project_case_study); `result` is hit | miss | error. Hit-rate =
 * rate(result="hit") / rate(result=~"hit|miss").
 */
export const redisCacheRequestsTotal = new Counter({
  name:       'redis_cache_requests_total',
  help:       'Read-cache outcomes by cache name and result.',
  labelNames: ['cache', 'result'] as const,
  registers:  [registry],
});
