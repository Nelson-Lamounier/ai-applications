#!/usr/bin/env python3
"""Import a Bedrock RAG-Evaluation job's results into rag_eval_runs.

Track 2 (deep audit). `to_bedrock_byoi.py` creates the job; Bedrock writes the
scored output to the job's S3 output location. This reads that output and inserts
a summary row under tool='bedrock', so the Bedrock run lands on the same Grafana
eval panels as the TS-native / DeepEval / RAGAS runs.

Bedrock writes a JSONL/JSON output per evaluation job. The exact shape varies by
metric set + API version, so this parses defensively: it pulls the headline RAG
metrics (context relevance/coverage, faithfulness, correctness, citation
precision/coverage) wherever they appear and stores the full metric map in
`notes`. VERIFY the field paths against your job's actual output on first run.

Usage:
    # from a downloaded results file:
    RAG_EVAL_PERSIST=1 RDS_HOST=... python from_bedrock_results.py results.json
    # or straight from S3:
    RAG_EVAL_PERSIST=1 RDS_HOST=... python from_bedrock_results.py s3://bucket/key
"""
from __future__ import annotations

import json
import sys

from persist_eval import persist_run

# Metric-name aliases Bedrock RAG eval has used; mapped to a normalized key.
_RELEVANCE_KEYS = ("context_relevance", "contextRelevance", "Context Relevance", "relevance")


def _read(path: str) -> str:
    if path.startswith("s3://"):
        import boto3  # local import: only needed for the S3 path
        _, _, rest = path.partition("s3://")
        bucket, _, key = rest.partition("/")
        return boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _flatten_metrics(doc: dict) -> dict:
    """Pull numeric metric scores out of a Bedrock eval result, defensively."""
    out: dict = {}
    # Common shapes: {"metrics":{"name":{"value":x}}} or {"results":[{"metricName","value"}]}
    metrics = doc.get("metrics") or doc.get("evaluationResults") or {}
    if isinstance(metrics, dict):
        for name, v in metrics.items():
            val = v.get("value") if isinstance(v, dict) else v
            if isinstance(val, (int, float)):
                out[name] = float(val)
    for row in doc.get("results", []) if isinstance(doc.get("results"), list) else []:
        name, val = row.get("metricName"), row.get("value")
        if name and isinstance(val, (int, float)):
            out[name] = float(val)
    return out


def main(path: str) -> int:
    raw = _read(path)
    # Output may be a single JSON doc or JSONL; aggregate metrics across lines.
    docs = []
    raw = raw.strip()
    if raw.startswith("["):
        docs = json.loads(raw)
    else:
        for line in raw.splitlines():
            if line.strip():
                docs.append(json.loads(line))

    all_metrics: dict = {}
    for d in docs:
        all_metrics.update(_flatten_metrics(d))

    relevance = next((all_metrics[k] for k in _RELEVANCE_KEYS if k in all_metrics), None)
    query_count = sum(1 for d in docs if "conversationTurns" in d or "prompt" in d) or len(docs)

    print(f"Bedrock metrics parsed: {all_metrics}")
    persist_run("bedrock", query_count, relevance, all_metrics)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: from_bedrock_results.py <results.json | s3://bucket/key>")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
