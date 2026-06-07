#!/usr/bin/env python3
"""DeepEval scorer — reads the RAG eval JSONL and runs DeepEval metrics.

Track 1 (offline/CI). Consumes the tool-agnostic JSONL emitted by
run-rag-eval.ts (one object per line):

    {"id","query","contexts":[{"source","cosine","snippet"}],"scores":[...],"answer"?}

Retrieval-only metrics (ContextualRelevancy) run without `answer`. When the
runner was invoked with RAG_EVAL_GENERATE=1, `answer` is present and the
retrieve-and-generate metrics (Faithfulness) are added.

Judge LLM: DeepEval defaults to OpenAI (OPENAI_API_KEY). To judge with Bedrock,
configure a custom model per DeepEval docs and pass it via `model=...` below.

Run:
    pip install -r requirements.txt
    python deepeval_harness.py /tmp/rag-eval.jsonl
"""
from __future__ import annotations

import json
import sys
from statistics import mean

from deepeval.test_case import LLMTestCase
from deepeval.metrics import ContextualRelevancyMetric, FaithfulnessMetric


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def main(path: str) -> int:
    rows = load(path)
    has_answers = all("answer" in r for r in rows)

    relevancy = ContextualRelevancyMetric(threshold=0.5)
    faithfulness = FaithfulnessMetric(threshold=0.5) if has_answers else None

    rel_scores: list[float] = []
    faith_scores: list[float] = []

    for r in rows:
        retrieval_context = [c["snippet"] for c in r.get("contexts", [])]
        if not retrieval_context:
            print(f"  {r['id']}: no context (recall miss / honest gap)")
            continue
        tc = LLMTestCase(
            input=r["query"],
            actual_output=r.get("answer", ""),
            retrieval_context=retrieval_context,
        )
        relevancy.measure(tc)
        rel_scores.append(relevancy.score)
        line = f"  {r['id']}: contextRelevancy={relevancy.score:.2f}"
        if faithfulness is not None and r.get("answer"):
            faithfulness.measure(tc)
            faith_scores.append(faithfulness.score)
            line += f" faithfulness={faithfulness.score:.2f}"
        print(line)

    print("\n=== DeepEval summary ===")
    print(f"mean contextRelevancy: {mean(rel_scores):.3f}" if rel_scores else "no relevancy scores")
    if faith_scores:
        print(f"mean faithfulness:     {mean(faith_scores):.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rag-eval.jsonl"))
