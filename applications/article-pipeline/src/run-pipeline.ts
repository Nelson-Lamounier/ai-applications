/**
 * @format
 * Article pipeline K8s Job entrypoint — replaces the Trigger/Research/Writer/QA
 * Lambda chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → writing → qa → complete (or failed at any step)
 *
 * On QA pass the rendered draft is persisted to platform RDS articles.status =
 * 'review'. The admin-api owns the eventual transition to 'published'.
 */
import type { PipelineContext } from '@bedrock/shared';

import { executeResearchAgent } from './agents/research-agent.js';
import { executeWriterAgent }   from './agents/writer-agent.js';
import { executeQaAgent }       from './agents/qa-agent.js';
import { parseEnv }             from './env.js';
import { getPool, closePool }   from './lib/pg.js';
import {
    updatePipelineRun,
    persistArticle,
} from './lib/pipeline-runs.js';

async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);

    const ctx: PipelineContext = {
        pipelineId:        env.pipelineId,
        slug:              env.slug,
        sourceKey:         env.s3SourceKey,
        bucket:            env.s3Bucket,
        environment:       env.environment,
        version:           parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt:      0,
        startedAt:         new Date().toISOString(),
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        const research = await executeResearchAgent(ctx);

        await updatePipelineRun(pool, env.pipelineRunId, 'writing');
        const writer = await executeWriterAgent(ctx, research.data);

        await updatePipelineRun(pool, env.pipelineRunId, 'qa');
        const qa = await executeQaAgent(
            ctx,
            writer.data,
            research.data.technicalFacts,
            research.data.mode,
        );

        // Final persist — write the rendered MDX back to platform RDS.
        await persistArticle(pool, env.slug, writer.data.content);

        await updatePipelineRun(pool, env.pipelineRunId, 'complete');

        console.log(JSON.stringify({
            event:         'article_pipeline_complete',
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            qaScore:       qa.data.overallScore,
            recommendation: qa.data.recommendation,
        }));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        console.error(JSON.stringify({
            event:         'article_pipeline_failed',
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            error:         message,
        }));
        throw err;
    } finally {
        await closePool();
    }
}

main().catch(() => process.exit(1));
