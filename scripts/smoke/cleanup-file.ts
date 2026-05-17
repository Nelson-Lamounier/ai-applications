/** @format */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { CleanupTarget, FlowName } from './types.js';

/** Append a cleanup record (one JSON line) to SMOKE_CLEANUP_FILE if set.
 *  No-op when unset so flow suites can run standalone. Best-effort:
 *  a write failure must never fail the test. */
export function recordCleanup(rec: {
  flow: FlowName; pipelineRunId?: string; slug?: string; s3Keys?: string[]; chatSessionId?: string;
}): void {
  const file = process.env.SMOKE_CLEANUP_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({
      flow: rec.flow,
      pipelineRunId: rec.pipelineRunId,
      slug: rec.slug,
      s3Keys: rec.s3Keys ?? [],
      chatSessionId: rec.chatSessionId,
    }) + '\n');
  } catch (e) {
    console.warn(`[smoke] recordCleanup failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Read+parse the cleanup file into normalised CleanupTarget[]. Missing
 *  file or bad lines yield [] / are skipped (cleanup must be resilient). */
export function readCleanupTargets(file: string): CleanupTarget[] {
  if (!existsSync(file)) return [];
  const out: CleanupTarget[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<CleanupTarget> & { flow: FlowName };
      out.push({
        flow: o.flow,
        pipelineRunId: o.pipelineRunId,
        slug: o.slug,
        s3Keys: o.s3Keys ?? [],
        chatSessionId: o.chatSessionId,
      });
    } catch { /* skip malformed line */ }
  }
  return out;
}
