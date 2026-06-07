/**
 * @format
 * RAG retrieval eval runner (LOCAL / CI — not deployed).
 *
 * Runs the REAL retrieval pipeline (Titan embed → RDS pgvector querySimilar) over
 * the golden set, scores context-relevance with an LLM judge (your Bedrock
 * ConverseCommand stack), computes recall@k deterministically, and prints a
 * report. Also writes a tool-agnostic JSONL ({query, contexts, scores}) that can
 * be fed to DeepEval / RAGAS / Bedrock-Evaluations BYOI.
 *
 * Run (with an SSM tunnel to dev RDS open on :15432 — e.g. `just rds-tunnel`):
 *   RUN_RAG_EVAL=1 USER_ID=<uuid> \
 *   RDS_HOST=127.0.0.1 RDS_PORT=15432 RDS_DB_NAME=tucaken RDS_USER=postgres RDS_PASSWORD=<secret> \
 *   AWS_PROFILE=dev-account AWS_REGION=eu-west-1 \
 *   npx tsx applications/job-strategist/src/evals/rag/run-rag-eval.ts
 *
 * Env: RUN_RAG_EVAL=1 (gate), USER_ID, RDS_* (RdsVectorStore.fromEnvironment),
 *      AWS_PROFILE/AWS_REGION, RAG_EVAL_K (default 8), RAG_JUDGE_MODEL_ID
 *      (default Haiku 4.5), KB_MIN_COSINE (default 0.20), RAG_EVAL_OUT_DIR.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RdsVectorStore, TitanEmbeddingProvider } from '@bedrock/shared';
import {
    recallAtK, aggregate, meanRelevance, buildRelevanceJudgePrompt,
    RELEVANCE_JUDGE_TOOL, parseRelevanceScores, formatReport,
    type GoldenQuery, type RetrievedContext, type QueryEvalResult,
} from './rag-score.js';

const JUDGE_MODEL = process.env.RAG_JUDGE_MODEL_ID ?? 'anthropic.claude-haiku-4-5-20251001-v1:0';
const K = Number.parseInt(process.env.RAG_EVAL_K ?? '8', 10);
const MIN_COSINE = Number.parseFloat(process.env.KB_MIN_COSINE ?? '0.20');
const SNIPPET_CHARS = 400;

interface ToolUseResponse { content?: Array<{ type: string; input?: unknown }> }

async function judgeRelevance(
    bedrock: BedrockRuntimeClient,
    query: string,
    contexts: RetrievedContext[],
): Promise<number[]> {
    if (contexts.length === 0) return [];
    const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens:        1024,
        temperature:       0,
        tools:             [RELEVANCE_JUDGE_TOOL],
        tool_choice:       { type: 'tool', name: RELEVANCE_JUDGE_TOOL.name },
        messages:          [{ role: 'user', content: buildRelevanceJudgePrompt(query, contexts) }],
    });
    const { body: resp } = await bedrock.send(new InvokeModelCommand({
        modelId: JUDGE_MODEL, contentType: 'application/json', accept: 'application/json',
        body: Buffer.from(body),
    }));
    const parsed = JSON.parse(Buffer.from(resp).toString('utf-8')) as ToolUseResponse;
    const toolUse = parsed.content?.find(b => b.type === 'tool_use');
    return parseRelevanceScores(toolUse?.input, contexts.length);
}

const OUT_DIR = process.env.RAG_EVAL_OUT_DIR ?? process.cwd();

function loadGolden(): GoldenQuery[] {
    const raw = readFileSync(join(__dirname, 'golden.json'), 'utf-8');
    return (JSON.parse(raw) as { queries: GoldenQuery[] }).queries;
}

async function main(): Promise<void> {
    if (process.env.RUN_RAG_EVAL !== '1') {
        console.log('RAG eval is gated. Set RUN_RAG_EVAL=1 (+ USER_ID, PG_*, AWS_REGION) to run.');
        return;
    }
    const userId = process.env.USER_ID;
    if (!userId) throw new Error('USER_ID is required');

    const embedder = TitanEmbeddingProvider.fromEnvironment();
    const store    = RdsVectorStore.fromEnvironment();
    const bedrock  = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

    const golden = loadGolden();
    const results: QueryEvalResult[] = [];
    const jsonl: string[] = [];

    for (const g of golden) {
        const queryEmbedding = await embedder.embed(g.query);
        const hits = await store.querySimilar({ userId, queryEmbedding, queryText: g.query, useHybrid: true, limit: K });
        const contexts: RetrievedContext[] = hits
            .filter(h => h.cosine >= MIN_COSINE)
            .map(h => ({ source: `${h.repoFullName}/${h.filePath}`, cosine: h.cosine, snippet: h.content.slice(0, SNIPPET_CHARS) }));

        const scores = await judgeRelevance(bedrock, g.query, contexts);
        const maxCosine = contexts.length > 0 ? Math.max(...contexts.map(c => c.cosine)) : 0;

        results.push({
            id: g.id, kind: g.kind,
            recallAtK: recallAtK(contexts, g, K),
            contextRelevance: meanRelevance(scores),
            retrievedCount: contexts.length,
            maxCosine,
        });
        jsonl.push(JSON.stringify({ id: g.id, query: g.query, contexts, scores }));
        console.log(`  scored ${g.id} (${contexts.length} ctx, relevance ${meanRelevance(scores).toFixed(2)})`);
    }

    const report = aggregate(results);
    console.log('\n' + formatReport(report));
    const jsonlPath = join(OUT_DIR, 'rag-eval.jsonl');
    const reportPath = join(OUT_DIR, 'rag-eval-report.json');
    writeFileSync(jsonlPath, jsonl.join('\n'));
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n==> wrote ${jsonlPath} (BYOI-ready) + ${reportPath}`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('rag-eval failed:', err); process.exit(1); });
