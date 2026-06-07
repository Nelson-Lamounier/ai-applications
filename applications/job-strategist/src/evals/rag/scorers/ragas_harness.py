#!/usr/bin/env python3
"""RAGAS scorer — reads the RAG eval JSONL and runs RAGAS metrics.

Lighter alternative to DeepEval. Consumes the same JSONL from run-rag-eval.ts.
Retrieval metrics (context relevance/precision) run without `answer`; faithfulness
+ answer-relevancy are added when the runner emitted `answer`
(RAG_EVAL_GENERATE=1).

Judge LLM + embeddings: RAGAS needs both. By default it uses OpenAI; for Bedrock,
wrap a langchain Bedrock chat model + embeddings and pass `llm=`/`embeddings=`
to `evaluate(...)` per RAGAS docs.

Run:
    pip install -r requirements.txt
    python ragas_harness.py /tmp/rag-eval.jsonl
"""
from __future__ import annotations

import json
import sys

from datasets import Dataset
from ragas import evaluate
from ragas.metrics import context_precision, faithfulness, answer_relevancy


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def main(path: str) -> int:
    rows = load(path)
    has_answers = all("answer" in r for r in rows)

    data = {
        "question":  [r["query"] for r in rows],
        "contexts":  [[c["snippet"] for c in r.get("contexts", [])] for r in rows],
        "answer":    [r.get("answer", "") for r in rows],
        # No human ground-truth answers in the seed set → context_precision uses
        # the question+contexts; add a 'ground_truth' column to enable context_recall.
    }
    dataset = Dataset.from_dict(data)

    metrics = [context_precision]
    if has_answers:
        metrics += [faithfulness, answer_relevancy]

    result = evaluate(dataset, metrics=metrics)
    print("=== RAGAS summary ===")
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rag-eval.jsonl"))
