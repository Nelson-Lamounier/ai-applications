# RAG evaluation — scorers

Two-track RAG evaluation, both fed by **one tool-agnostic artifact**: the JSONL
emitted by [`run-rag-eval.ts`](../run-rag-eval.ts). The retrieval half is always
the **real pipeline** (Titan embed → RDS pgvector `querySimilar` + cosine floor);
only the scoring half varies.

## The seam — `rag-eval.jsonl`
One object per line (from `just rag-eval` / `run-rag-eval.ts`):
```json
{ "id": "k8s-networking",
  "query": "kubernetes networking…",
  "contexts": [ { "source": "owner/repo/path", "cosine": 0.31, "snippet": "…" } ],
  "scores": [0.9, 0.2, …],          // TS-native judge, context-relevance per ctx
  "answer": "…[0]…" }               // present only with RAG_EVAL_GENERATE=1
```
Add `answer` (set `RAG_EVAL_GENERATE=1` on the runner) to unlock
retrieve-**and-generate** metrics (faithfulness, correctness, citation precision).

## Track 1 — offline / CI (fast regression loop)
- **TS-native** (default, no extra runtime): `just rag-eval` → console report +
  `rag-eval-report.json`. Pure scoring is unit-tested (`rag-score.test.ts`).
- **DeepEval** (Python): `pip install -r requirements.txt && python deepeval_harness.py rag-eval.jsonl`
  — ContextualRelevancy (+ Faithfulness with `answer`).
- **RAGAS** (Python, lighter): `python ragas_harness.py rag-eval.jsonl`
  — context_precision (+ faithfulness, answer_relevancy with `answer`).

> DeepEval/RAGAS need a **judge LLM** (default OpenAI). To judge with Bedrock,
> configure a custom model per each tool's docs and pass it in — hooks noted in
> the harness headers.

## Track 2 — periodic deeper audit (Bedrock Evaluations, BYOI)
Bedrock RAG Evaluation went GA and supports **bring-your-own-inference** — score
your own contexts + answers, no managed Knowledge Base. Convert + (optionally)
launch:
```bash
python to_bedrock_byoi.py rag-eval.jsonl \
  --bucket <evals-bucket> --prefix rag/$(date +%F) \
  --role-arn <BedrockEvalRole> --judge-model <judge> --region eu-west-1
```
Gives citation precision/coverage + faithfulness with **published judge rubrics**.

## Recommended workflow
1. Baseline: `RAG_EVAL_GENERATE=1 just rag-eval` → record TS-native numbers + keep the JSONL.
2. Change the scan (FileFilter, fast-scan, re-ingest) → re-run → diff the numbers.
3. Periodically: feed the same JSONL to Bedrock BYOI for the deep, rubric-backed audit.

> The Python harnesses and the Bedrock converter are **ready-to-run scaffolds** —
> validate against your installed tool versions + current Bedrock API on first run
> (schemas evolve), then pin in `requirements.txt`.
