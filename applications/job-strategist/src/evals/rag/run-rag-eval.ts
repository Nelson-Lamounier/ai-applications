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
import { Pool } from 'pg';
import {
    RdsVectorStore, TitanEmbeddingProvider,
    SkillOntologyRepository, TechnologyOntologyRepository,
    type RetrievalPrefilter,
} from '@bedrock/shared';
import { buildRetrievalPrefilter } from '../../ats/retrieval-prefilter.js';
import {
    recallAtK, aggregate, meanRelevance, buildRelevanceJudgePrompt,
    RELEVANCE_JUDGE_TOOL, parseRelevanceScores, formatReport,
    type GoldenQuery, type RetrievedContext, type QueryEvalResult, type RagEvalReport,
} from './rag-score.js';

// eu-west-1 rejects on-demand bare model ids — must use the EU cross-region
// inference profile (eu.* prefix), same constraint as the chunk enricher.
const JUDGE_MODEL = process.env.RAG_JUDGE_MODEL_ID ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const K = Number.parseInt(process.env.RAG_EVAL_K ?? '8', 10);
const MIN_COSINE = Number.parseFloat(process.env.KB_MIN_COSINE ?? '0.20');
const SNIPPET_CHARS = 400;
/** RAG_EVAL_GENERATE=1 → also generate a grounded answer per query, so the JSONL
 *  carries `answer` for retrieve-AND-generate metrics (faithfulness, correctness,
 *  citation precision) in DeepEval / RAGAS / Bedrock-Evaluations BYOI. */
const GENERATE = process.env.RAG_EVAL_GENERATE === '1';
/** RAG_EVAL_PERSIST=1 → also write the run + per-query rows to RDS
 *  (rag_eval_runs / rag_eval_results) so Grafana can chart quality over time. */
const PERSIST = process.env.RAG_EVAL_PERSIST === '1';
/** RAG_EVAL_HYBRID=0 → pure-vector (cosine) retrieval; default = hybrid
 *  (vector + BM25 RRF). Toggle to run a cosine-vs-hybrid A/B on the same golden
 *  set: run once with RAG_EVAL_HYBRID=0, once with =1, compare meanRecallAtK. */
const HYBRID = process.env.RAG_EVAL_HYBRID !== '0';
/** RAG_EVAL_PREFILTER=on → run each query through the filter-then-rank prefilter
 *  lane (the RETRIEVAL_PREFILTER=on production path). Query-side terms are derived
 *  DETERMINISTICALLY: the query text is matched against the skill- and
 *  tech-ontology alias maps (no LLM, no embedding resolver), then transfer-group
 *  expanded via buildRetrievalPrefilter — identical inputs across A/B legs.
 *  Note: the prefilter routes through the vector path (no BM25), so compare
 *  prefilter legs against each other, not against the hybrid baseline. */
const PREFILTER = process.env.RAG_EVAL_PREFILTER === 'on';
/** RAG_EVAL_SKILLS_LANE=0 → disable the LLM-enriched `d.skills &&` admitter inside
 *  the prefilter (retrieval as if chunk enrichment were retired). The enrichment
 *  A/B is: RAG_EVAL_PREFILTER=on RAG_EVAL_SKILLS_LANE=1 vs =0. */
const SKILLS_LANE = process.env.RAG_EVAL_SKILLS_LANE !== '0';
const MODE = PREFILTER ? (SKILLS_LANE ? 'prefilter+skills' : 'prefilter-noskills') : (HYBRID ? 'hybrid' : 'vector');

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
    // Tolerate transient Bedrock 500s: retry with backoff, then degrade to 0s for
    // this query rather than aborting the whole run.
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const { body: resp } = await bedrock.send(new InvokeModelCommand({
                modelId: JUDGE_MODEL, contentType: 'application/json', accept: 'application/json',
                body: Buffer.from(body),
            }));
            const parsed = JSON.parse(Buffer.from(resp).toString('utf-8')) as ToolUseResponse;
            const toolUse = parsed.content?.find(b => b.type === 'tool_use');
            return parseRelevanceScores(toolUse?.input, contexts.length);
        } catch (err) {
            if (attempt === 4) {
                console.warn(`  judge failed after ${attempt} attempts (${String(err)}) — scoring 0 for this query`);
                return contexts.map(() => 0);
            }
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
    return contexts.map(() => 0);
}

const OUT_DIR = process.env.RAG_EVAL_OUT_DIR ?? process.cwd();

/** Grounded answer from the retrieved contexts (citations as [n]) — enables
 *  retrieve-and-generate metrics. Honesty-constrained: refuse when unsupported. */
async function generateAnswer(bedrock: BedrockRuntimeClient, query: string, contexts: RetrievedContext[]): Promise<string> {
    const ctxBlock = contexts.map((c, i) => `[${i}] ${c.source}\n${c.snippet}`).join('\n\n');
    const prompt = [
        'Answer the QUERY using ONLY the CONTEXTS. Cite sources inline as [n]. If the',
        'contexts do not support an answer, say so plainly — do not invent.',
        '', `QUERY: ${query}`, '', 'CONTEXTS:', ctxBlock || '(none)',
    ].join('\n');
    const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 512, temperature: 0,
        messages: [{ role: 'user', content: prompt }],
    });
    const { body: resp } = await bedrock.send(new InvokeModelCommand({
        modelId: JUDGE_MODEL, contentType: 'application/json', accept: 'application/json', body: Buffer.from(body),
    }));
    const parsed = JSON.parse(Buffer.from(resp).toString('utf-8')) as { content?: Array<{ type: string; text?: string }> };
    return parsed.content?.find(b => b.type === 'text')?.text ?? '';
}

function loadGolden(): { version: number | null; queries: GoldenQuery[] } {
    const raw = readFileSync(join(__dirname, 'golden.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; queries: GoldenQuery[] };
    return { version: parsed.version ?? null, queries: parsed.queries };
}

function makePool(): Pool {
    return new Pool({
        host:     process.env.RDS_HOST,
        port:     Number.parseInt(process.env.RDS_PORT ?? '5432', 10),
        database: process.env.RDS_DB_NAME,
        user:     process.env.RDS_USER,
        password: process.env.RDS_PASSWORD,
        // Match RdsVectorStore: SSL over the SSM tunnel for the local eval (RDS_SSL=require).
        ssl:      process.env.RDS_SSL === 'require' ? { rejectUnauthorized: false } : false,
    });
}

interface OntologyMaps {
    techGroups: string[][];
    techAliasToCanonical: Map<string, string>;
    skillAliasToCanonical: Map<string, string>;
}

/** Load the same ontology maps the production prefilter uses (fail-open to empty). */
async function loadOntologyMaps(pool: Pool): Promise<OntologyMaps> {
    const techRepo = new TechnologyOntologyRepository(pool);
    const [transfer, category, techAlias, skillAlias] = await Promise.all([
        techRepo.loadTransferGroups().catch(() => [] as string[][]),
        techRepo.loadCategoryGroups().catch(() => [] as string[][]),
        techRepo.loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
        new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
    ]);
    return {
        techGroups: transfer.length > 0 ? transfer : category,
        techAliasToCanonical: techAlias,
        skillAliasToCanonical: skillAlias,
    };
}

/** Word-boundary match of ontology aliases (and canonicals) inside the query text.
 *  Underscore canonicals match their spaced/hyphenated surface forms. Deterministic
 *  by construction so both A/B legs see byte-identical query terms. */
function matchAliases(queryLower: string, aliasToCanonical: ReadonlyMap<string, string>): string[] {
    const candidates = new Map(aliasToCanonical);
    for (const canonical of aliasToCanonical.values()) candidates.set(canonical, canonical);
    const hits = new Set<string>();
    for (const [alias, canonical] of candidates) {
        const a = alias.toLowerCase().trim();
        if (a.length < 2) continue; // single-char aliases ("r", "c") are pure false-positive noise
        const escaped = a.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('_', '[ _-]');
        if (new RegExp(`\\b${escaped}\\b`).test(queryLower)) hits.add(canonical);
    }
    return [...hits].sort();
}

/** Per-query prefilter for the A/B legs; undefined when RAG_EVAL_PREFILTER is off
 *  (or when the query surfaces no ontology terms — the widener is then a no-op
 *  by its own cardinality guard, which the report flags per query). */
function buildQueryPrefilter(query: string, maps: OntologyMaps): RetrievalPrefilter | undefined {
    if (!PREFILTER) return undefined;
    const q = query.toLowerCase();
    const skills = matchAliases(q, maps.skillAliasToCanonical);
    const tech = matchAliases(q, maps.techAliasToCanonical);
    const base = buildRetrievalPrefilter(skills, tech, maps.techGroups, maps.techAliasToCanonical);
    return { ...base, skillsLane: SKILLS_LANE };
}

/** Persist the run + per-query rows to RDS for the Grafana eval panels. */
async function persistEvalRun(report: RagEvalReport, datasetVersion: number | null): Promise<void> {
    const pool = makePool();
    try {
        const run = await pool.query<{ id: string }>(
            `INSERT INTO rag_eval_runs
               (tool, dataset_version, generate_answers, k, min_cosine,
                query_count, positive_count, negative_count,
                mean_recall_at_k, mean_relevance_positive, mean_relevance_negative, mean_max_cosine, notes)
             VALUES ('ts-native', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [datasetVersion, GENERATE, K, MIN_COSINE,
             report.queryCount, report.positiveCount, report.negativeCount,
             report.meanRecallAtK, report.meanRelevancePositive, report.meanRelevanceNegative, report.meanMaxCosine,
             `retrieval_mode=${MODE}`],
        );
        const runId = run.rows[0]?.id;
        if (!runId) throw new Error('rag_eval_runs insert returned no id');
        for (const r of report.perQuery) {
            await pool.query(
                `INSERT INTO rag_eval_results
                   (run_id, query_id, kind, recall_at_k, context_relevance, retrieved_count, max_cosine)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [runId, r.id, r.kind, r.recallAtK, r.contextRelevance, r.retrievedCount, r.maxCosine],
            );
        }
        console.log(`==> persisted eval run ${runId} (${report.perQuery.length} queries) to rag_eval_runs`);
    } finally {
        await pool.end();
    }
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

    const { version: datasetVersion, queries: golden } = loadGolden();
    console.log(`==> retrieval mode: ${MODE} | k=${K}`);

    let maps: OntologyMaps | undefined;
    if (PREFILTER) {
        const pool = makePool();
        try {
            maps = await loadOntologyMaps(pool);
        } finally {
            await pool.end();
        }
        console.log(`==> ontology loaded: ${maps.techAliasToCanonical.size} tech aliases, ${maps.skillAliasToCanonical.size} skill aliases, ${maps.techGroups.length} transfer groups | skills lane: ${SKILLS_LANE ? 'ON' : 'OFF'}`);
    }

    const results: QueryEvalResult[] = [];
    const jsonl: string[] = [];

    for (const g of golden) {
        const queryEmbedding = await embedder.embed(g.query);
        const prefilter = maps ? buildQueryPrefilter(g.query, maps) : undefined;
        const hits = await store.querySimilar({
            userId, queryEmbedding, queryText: g.query, useHybrid: HYBRID, limit: K,
            ...(prefilter ? { prefilter } : {}),
        });
        const contexts: RetrievedContext[] = hits
            .filter(h => h.cosine >= MIN_COSINE)
            .map(h => ({ source: `${h.repoFullName}/${h.filePath}`, cosine: h.cosine, snippet: h.content.slice(0, SNIPPET_CHARS) }));

        const scores = await judgeRelevance(bedrock, g.query, contexts);
        const answer = GENERATE ? await generateAnswer(bedrock, g.query, contexts) : undefined;
        const maxCosine = contexts.length > 0 ? Math.max(...contexts.map(c => c.cosine)) : 0;

        results.push({
            id: g.id, kind: g.kind,
            recallAtK: recallAtK(contexts, g, K),
            contextRelevance: meanRelevance(scores),
            retrievedCount: contexts.length,
            maxCosine,
        });
        jsonl.push(JSON.stringify({
            id: g.id, query: g.query, contexts, scores,
            ...(prefilter ? { prefilterTerms: { skills: prefilter.skills, tech: prefilter.tech, skillsLane: SKILLS_LANE } } : {}),
            ...(answer !== undefined ? { answer } : {}),
        }));
        const termNote = prefilter ? ` | terms s=${prefilter.skills.length} t=${prefilter.tech.length}` : '';
        console.log(`  scored ${g.id} (${contexts.length} ctx, relevance ${meanRelevance(scores).toFixed(2)}${termNote})`);
    }

    const report = aggregate(results);
    console.log('\n' + formatReport(report));
    const jsonlPath = join(OUT_DIR, 'rag-eval.jsonl');
    const reportPath = join(OUT_DIR, 'rag-eval-report.json');
    writeFileSync(jsonlPath, jsonl.join('\n'));
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n==> wrote ${jsonlPath} (BYOI-ready) + ${reportPath}`);

    if (PERSIST) {
        await persistEvalRun(report, datasetVersion);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('rag-eval failed:', err); process.exit(1); });
