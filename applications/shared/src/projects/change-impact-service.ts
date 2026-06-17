/**
 * @format
 * change-impact-service — the query-time consumer that turns "what's the impact
 * of the changes to file X?" into a grounded narration.
 *
 * Ties together the pieces built across Inc 1-3b:
 *   getFileChanges (stored diffs)  → buildFileChangeImpact (deterministic facts)
 *   + getMeasuredPerf (oldest/newest SHA) → buildChangeImpactReport (computed %)
 *   → narrateChangeImpact (gated narration).
 *
 * The store is a structural dependency (RdsRepoActivityStore satisfies it) and
 * the model call is injectable, so the whole flow is unit-testable without a DB
 * or live Bedrock. A route, chatbot tool, or coach can call this with a file path.
 */

import type { FileChange, PerfMetric } from '../rds/implementations/RdsRepoActivityStore.js';
import { buildFileChangeImpact, buildChangeImpactReport } from './change-metrics.js';
import type { ChangeImpactReport } from './change-metrics.js';
import { narrateChangeImpact } from './change-impact-narrator.js';
import type { ChangeImpactNarration, NarrateInvoke } from './change-impact-narrator.js';

/** The persistence surface the consumer needs (RdsRepoActivityStore implements it). */
export interface ChangeImpactStore {
    getFileChanges(userId: string, repoFullName: string, filePath: string, limit?: number): Promise<FileChange[]>;
    getMeasuredPerf(userId: string, repoFullName: string, sha: string): Promise<PerfMetric[]>;
}

export interface FileChangeImpactResult {
    readonly report: ChangeImpactReport;
    readonly narration: ChangeImpactNarration;
}

export interface NarrateFileChangeImpactOptions {
    /** Cap on the file's change history pulled. Default 50. */
    readonly limit?: number;
    /** Inject the model call (tests); omit to use the default Bedrock invoker. */
    readonly invoke?: NarrateInvoke;
}

/**
 * Build and narrate the change impact for one file. Returns null when the file
 * has no stored change history. Performance is compared between the OLDEST and
 * NEWEST commits that touched the file — and only surfaces a percentage when
 * both were measured (otherwise the narration honestly claims none).
 */
export async function narrateFileChangeImpact(
    store: ChangeImpactStore,
    userId: string,
    repoFullName: string,
    filePath: string,
    opts: NarrateFileChangeImpactOptions = {},
): Promise<FileChangeImpactResult | null> {
    const changes = await store.getFileChanges(userId, repoFullName, filePath, opts.limit ?? 50);
    if (changes.length === 0) return null;

    const impact = buildFileChangeImpact(filePath, changes);

    // getFileChanges is newest-first → after = first, before = last.
    const afterSha  = changes[0]!.commitSha;
    const beforeSha = changes[changes.length - 1]!.commitSha;
    const [beforePerf, afterPerf] = await Promise.all([
        store.getMeasuredPerf(userId, repoFullName, beforeSha),
        store.getMeasuredPerf(userId, repoFullName, afterSha),
    ]);

    const report = buildChangeImpactReport(impact, beforePerf, afterPerf);
    const narration = await narrateChangeImpact(report, { invoke: opts.invoke });
    return { report, narration };
}
