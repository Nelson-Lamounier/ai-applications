/**
 * @file metrics.ts
 * @description GET /metrics — Prometheus exposition. NetworkPolicy restricts
 * scraping to the monitoring namespace (chart networkpolicy.yaml).
 */
import { Hono } from 'hono';
import { registry } from '../lib/metrics.js';

const metrics = new Hono();

metrics.get('/metrics', async (c) => {
  const body = await registry.metrics();
  return c.body(body, 200, { 'Content-Type': registry.contentType });
});

export default metrics;
